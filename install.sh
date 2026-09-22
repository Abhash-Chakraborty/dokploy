#!/usr/bin/env bash
#
# Installs this Dokploy fork on a Linux host:
#   curl -fsSL https://raw.githubusercontent.com/Abhash-Chakraborty/dokploy/main/install.sh | sudo bash
#
# Provisions everything the image expects: Docker Swarm, the attachable
# dokploy-network overlay, Postgres and Redis services, Docker secrets for the
# database password and auth secret, the Dokploy service itself and Traefik.
# Safe to re-run: existing secrets, data volumes and services are reused, and a
# half-finished install is repaired.
#
#   sudo bash install.sh           install or repair
#   sudo bash install.sh update    pull the image and roll the dokploy service
#
# Environment overrides:
#   DOKPLOY_IMAGE        image to run (default ghcr.io/abhash-chakraborty/dokploy:latest)
#   DOKPLOY_URL          public URL, e.g. https://dokploy.example.com (sets BETTER_AUTH_URL)
#   ADVERTISE_ADDR       address for `docker swarm init` and swarm joins
#   DOCKER_SWARM_INIT_ARGS  extra `docker swarm init` arguments
#   ENDPOINT_MODE=dnsrr  for kernels without IPVS (Proxmox LXC is detected)
#   SKIP_TRAEFIK=1       do not start the Traefik container
set -euo pipefail

IMAGE="${DOKPLOY_IMAGE:-ghcr.io/abhash-chakraborty/dokploy:latest}"
UPDATE_IMAGE="${DOKPLOY_UPDATE_IMAGE:-ghcr.io/abhash-chakraborty/dokploy}"
APP_PORT="${DOKPLOY_PORT:-3000}"
POSTGRES_IMAGE="${DOKPLOY_POSTGRES_IMAGE:-postgres:16}"
REDIS_IMAGE="${DOKPLOY_REDIS_IMAGE:-redis:7}"
TRAEFIK_IMAGE="${DOKPLOY_TRAEFIK_IMAGE:-traefik:v3.6.25}"
NETWORK=dokploy-network
PG_SECRET=dokploy_postgres_password
AUTH_SECRET=dokploy_auth_secret
# The fork's first installer used this name; keep using it when it exists so a
# re-run does not sign everyone out.
LEGACY_AUTH_SECRET=dokploy_better_auth_secret

info() { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[0;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}

service_exists() { docker service inspect "$1" >/dev/null 2>&1; }
secret_exists() { docker secret inspect "$1" >/dev/null 2>&1; }

random_secret() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
	fi
}

port_in_use() {
	if command -v ss >/dev/null 2>&1; then
		ss -Htln "sport = :$1" 2>/dev/null | grep -q .
	else
		(exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
	fi
}

is_proxmox_lxc() {
	[ "${container:-}" = "lxc" ] || grep -qa "container=lxc" /proc/1/environ 2>/dev/null
}

public_ip() {
	local ip=""
	for url in https://ifconfig.io https://icanhazip.com https://api.ipify.org; do
		ip="$(curl -4fsS --connect-timeout 5 "$url" 2>/dev/null || true)"
		[ -n "$ip" ] && break
	done
	echo "$ip"
}

private_ip() {
	# Docker's own interfaces are host-local and useless to other swarm nodes.
	ip -o -4 addr show scope global 2>/dev/null |
		awk '$2 !~ /^(docker|br-|veth)/ {print $4}' |
		cut -d/ -f1 |
		grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' |
		head -n1 || true
}

wait_for() {
	local what="$1" seconds="$2"
	shift 2
	for _ in $(seq 1 "$seconds"); do
		if "$@" >/dev/null 2>&1; then return 0; fi
		sleep 1
	done
	die "timed out after ${seconds}s waiting for $what"
}

preflight() {
	[ "$(uname -s)" = "Linux" ] || die "Dokploy installs on Linux only"
	[ "$(id -u)" = "0" ] || die "run as root, e.g. curl -fsSL <url> | sudo bash"
	[ -f /.dockerenv ] && die "run this on the host, not inside a container"

	if ! command -v docker >/dev/null 2>&1; then
		info "Installing Docker"
		curl -fsSL https://get.docker.com | sh
	fi
	docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not reachable"
	command -v curl >/dev/null 2>&1 || die "curl is required"
}

ensure_swarm() {
	local state
	state="$(docker info --format '{{.Swarm.LocalNodeState}}')"
	if [ "$state" = "active" ]; then
		[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" = "true" ] ||
			die "this node is a swarm worker; run the installer on a manager"
		ADVERTISE_ADDR="${ADVERTISE_ADDR:-$(docker info --format '{{.Swarm.NodeAddr}}')}"
		info "Using the existing swarm ($ADVERTISE_ADDR)"
		return
	fi
	ADVERTISE_ADDR="${ADVERTISE_ADDR:-$(private_ip)}"
	ADVERTISE_ADDR="${ADVERTISE_ADDR:-$(public_ip)}"
	[ -n "$ADVERTISE_ADDR" ] || die "could not detect this server's IP; set ADVERTISE_ADDR"
	info "Initialising swarm on $ADVERTISE_ADDR"
	# shellcheck disable=SC2086 # extra arguments are meant to split
	docker swarm init --advertise-addr "$ADVERTISE_ADDR" ${DOCKER_SWARM_INIT_ARGS:-} >/dev/null
}

ensure_network() {
	if docker network inspect "$NETWORK" >/dev/null 2>&1; then
		if [ "$(docker network inspect -f '{{.Attachable}}' "$NETWORK")" = "true" ]; then
			return
		fi
		# Traefik joins with `docker run --network`, which needs an attachable
		# overlay. Earlier fork installers made a plain one.
		warn "$NETWORK is not attachable; recreating it"
		service_exists dokploy && docker service rm dokploy >/dev/null
		wait_for "services to leave $NETWORK" 60 sh -c \
			"[ -z \"\$(docker network inspect -f '{{range .Containers}}x{{end}}' $NETWORK)\" ]"
		docker network rm "$NETWORK" >/dev/null ||
			die "$NETWORK is still in use; detach its services and re-run"
	fi
	info "Creating the $NETWORK overlay network"
	docker network create --driver overlay --attachable "$NETWORK" >/dev/null
}

ensure_secrets() {
	if ! secret_exists "$PG_SECRET"; then
		if docker volume inspect dokploy-postgres >/dev/null 2>&1; then
			die "volume dokploy-postgres exists but secret $PG_SECRET does not, so the database password is unknown; recreate the secret with that password and re-run"
		fi
		random_secret | tr -d '\n' | docker secret create "$PG_SECRET" - >/dev/null
		info "Created secret $PG_SECRET"
	fi
	if ! secret_exists "$AUTH_SECRET" && secret_exists "$LEGACY_AUTH_SECRET"; then
		AUTH_SECRET="$LEGACY_AUTH_SECRET"
	fi
	if ! secret_exists "$AUTH_SECRET"; then
		random_secret | tr -d '\n' | docker secret create "$AUTH_SECRET" - >/dev/null
		info "Created secret $AUTH_SECRET"
	fi
}

ensure_postgres() {
	if ! service_exists dokploy-postgres; then
		info "Creating dokploy-postgres"
		# shellcheck disable=SC2086
		docker service create --detach \
			--name dokploy-postgres \
			--constraint 'node.role==manager' \
			--network "$NETWORK" \
			--env POSTGRES_USER=dokploy \
			--env POSTGRES_DB=dokploy \
			--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
			--secret source="$PG_SECRET",target=/run/secrets/postgres_password \
			--mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
			$ENDPOINT_ARGS \
			"$POSTGRES_IMAGE" >/dev/null
	fi
	info "Waiting for Postgres to accept connections"
	wait_for "dokploy-postgres to start" 180 sh -c "[ -n \"\$(docker ps -q --filter label=com.docker.swarm.service.name=dokploy-postgres --filter status=running)\" ]"
	wait_for "Postgres to accept connections" 120 sh -c \
		"docker exec \$(docker ps -q --filter label=com.docker.swarm.service.name=dokploy-postgres --filter status=running | head -n1) pg_isready -U dokploy -d dokploy"
}

ensure_redis() {
	service_exists dokploy-redis && return
	info "Creating dokploy-redis"
	# shellcheck disable=SC2086
	docker service create --detach \
		--name dokploy-redis \
		--constraint 'node.role==manager' \
		--network "$NETWORK" \
		--mount type=volume,source=dokploy-redis,target=/data \
		$ENDPOINT_ARGS \
		"$REDIS_IMAGE" >/dev/null
}

create_dokploy() {
	local auth_url="${BETTER_AUTH_URL:-${DOKPLOY_URL:-}}"
	if [ -z "$auth_url" ]; then
		local host
		host="$(public_ip)"
		host="${host:-$(private_ip)}"
		auth_url="http://${host:-localhost}:${APP_PORT}"
	fi

	if service_exists dokploy; then
		info "Replacing the existing dokploy service"
		docker service rm dokploy >/dev/null
		# The published host port is only released once the old task is gone.
		wait_for "the old dokploy task to stop" 90 sh -c \
			"[ -z \"\$(docker ps -aq --filter label=com.docker.swarm.service.name=dokploy)\" ]"
	fi
	port_in_use "$APP_PORT" && die "port $APP_PORT is already in use"

	mkdir -p /etc/dokploy
	chmod 755 /etc/dokploy

	info "Creating the dokploy service ($IMAGE)"
	# shellcheck disable=SC2086
	docker service create --detach \
		--name dokploy \
		--replicas 1 \
		--constraint 'node.role == manager' \
		--network "$NETWORK" \
		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
		--mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
		--mount type=volume,source=dokploy,target=/root/.docker \
		--secret source="$PG_SECRET",target=/run/secrets/postgres_password \
		--secret source="$AUTH_SECRET",target=/run/secrets/dokploy_auth_secret \
		--publish published="$APP_PORT",target=3000,mode=host \
		--update-parallelism 1 \
		--update-order stop-first \
		--env NODE_ENV=production \
		--env RELEASE_TAG=latest \
		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		--env BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
		--env BETTER_AUTH_URL="$auth_url" \
		--env DOKPLOY_UPDATE_IMAGE="$UPDATE_IMAGE" \
		${ADVERTISE_ADDR:+--env ADVERTISE_ADDR=$ADVERTISE_ADDR} \
		${GITHUB_CLIENT_ID:+--env GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID} \
		${GITHUB_CLIENT_SECRET:+--env GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET} \
		${GOOGLE_CLIENT_ID:+--env GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID} \
		${GOOGLE_CLIENT_SECRET:+--env GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET} \
		$ENDPOINT_ARGS \
		"$IMAGE" >/dev/null
	DOKPLOY_URL_SHOWN="$auth_url"
}

wait_for_dokploy() {
	info "Waiting for Dokploy to finish migrations and start (first boot takes a minute or two)"
	local healthy=""
	for _ in $(seq 1 300); do
		if curl -fs "http://127.0.0.1:${APP_PORT}/api/trpc/settings.health" >/dev/null 2>&1; then
			healthy=1
			break
		fi
		sleep 1
	done
	if [ -z "$healthy" ]; then
		docker service ps dokploy --no-trunc >&2 || true
		docker service logs --tail 40 dokploy >&2 || true
		die "Dokploy did not become healthy within 5 minutes; the log above says why"
	fi
}

ensure_traefik() {
	if [ -n "${SKIP_TRAEFIK:-}" ]; then
		warn "SKIP_TRAEFIK set; not starting Traefik"
		return
	fi
	if docker container inspect dokploy-traefik >/dev/null 2>&1; then
		docker start dokploy-traefik >/dev/null
		return
	fi
	# Dokploy writes the static config on boot. Mounting a path that does not
	# exist yet would make Docker create a directory in its place.
	[ -f /etc/dokploy/traefik/traefik.yml ] ||
		die "/etc/dokploy/traefik/traefik.yml was not written by Dokploy"
	local port
	for port in 80 443; do
		if port_in_use "$port"; then
			warn "port $port is in use, so Traefik was not started; free it and re-run"
			return
		fi
	done
	info "Starting Traefik"
	docker pull -q "$TRAEFIK_IMAGE" >/dev/null
	docker run -d \
		--name dokploy-traefik \
		--restart always \
		--network "$NETWORK" \
		-v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
		-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
		-v /var/run/docker.sock:/var/run/docker.sock:ro \
		-p 80:80/tcp -p 443:443/tcp -p 443:443/udp \
		"$TRAEFIK_IMAGE" >/dev/null
}

install() {
	preflight
	ENDPOINT_ARGS=""
	if [ "${ENDPOINT_MODE:-}" = "dnsrr" ] || is_proxmox_lxc; then
		warn "using --endpoint-mode dnsrr (no IPVS in this environment)"
		ENDPOINT_ARGS="--endpoint-mode dnsrr"
	fi
	ensure_swarm
	ensure_network
	ensure_secrets
	ensure_postgres
	ensure_redis
	info "Pulling $IMAGE"
	docker pull -q "$IMAGE" >/dev/null
	create_dokploy
	wait_for_dokploy
	ensure_traefik

	printf '\n\033[0;32mDokploy is running.\033[0m Open %s\n' "$DOKPLOY_URL_SHOWN"
}

update() {
	preflight
	service_exists dokploy || die "dokploy is not installed; run without arguments first"
	info "Pulling $IMAGE"
	docker pull -q "$IMAGE" >/dev/null
	docker service update --detach --image "$IMAGE" dokploy >/dev/null
	info "Updated the dokploy service to $IMAGE"
}

case "${1:-install}" in
install) install ;;
update) update ;;
*) die "usage: install.sh [install|update]" ;;
esac
