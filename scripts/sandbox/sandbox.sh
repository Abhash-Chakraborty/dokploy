#!/usr/bin/env bash
# Isolated dev/test environment for a checkout that lives on a production
# Docker host. Starts labelled throwaway Postgres, Redis and Docker-in-Docker
# on 127.0.0.1, and runs the app, migrations and tests against them only.
#
#   sandbox.sh up [--oidc|--traefik|--fleet]
#                                        start dependencies
#   sandbox.sh env                       print the sandbox environment
#   sandbox.sh migrate                   run migrations against the sandbox DB
#   sandbox.sh dev                       run the dev server against the sandbox
#   sandbox.sh test [vitest args]        run the test suite, real-Docker suites
#                                        included, against the sandbox daemon
#   sandbox.sh test:integration          run DB-backed integration tests
#   sandbox.sh exec -- <cmd...>          run any command with the sandbox env
#   sandbox.sh psql                      open psql on the sandbox DB
#   sandbox.sh status | down
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
HERE="$ROOT/scripts/sandbox"
STATE="$ROOT/.sandbox"
# One sandbox per checkout, so parallel worktrees do not collide.
SANDBOX_ID=${SANDBOX_ID:-$(printf %s "$ROOT" | sha1sum | cut -c1-8)}
LABEL="com.abhash.sandbox=$SANDBOX_ID"
PORTS_FILE="$STATE/ports.env"
ENV_FILE="$STATE/app.env"
export SANDBOX_ID

die() { echo "sandbox: $*" >&2; exit 1; }

compose() {
	docker compose --env-file "$PORTS_FILE" -f "$HERE/compose.sandbox.yml" "$@"
}

free_port() {
	node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

load_ports() {
	[ -f "$PORTS_FILE" ] || die "not running; start it with: sandbox.sh up"
	set -a
	# shellcheck disable=SC1090
	. "$PORTS_FILE"
	set +a
}

# Refuses anything that could reach production: the prod DB/Redis ports, a
# non-loopback host, or the host Docker socket.
guard() {
	load_ports
	for p in "$PG_PORT" "$REDIS_PORT" "$DIND_PORT"; do
		case "$p" in 5432 | 6379 | 2375 | 2376 | "") die "refusing suspicious port '$p'" ;; esac
	done
	[ "$(docker ps -q --filter "label=$LABEL" --filter "name=dind" | wc -l)" -ge 1 ] ||
		die "sandbox daemon is not running (label $LABEL)"
}

write_app_env() {
	cat >"$ENV_FILE" <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=$APP_PORT
DATABASE_URL=postgres://dokploy:sandbox@127.0.0.1:$PG_PORT/dokploy
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
BETTER_AUTH_URL=http://127.0.0.1:$APP_PORT
BETTER_AUTH_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
DOCKER_HOST=tcp://127.0.0.1:$DIND_PORT
DOKPLOY_DOCKER_HOST=127.0.0.1
DOKPLOY_DOCKER_PORT=$DIND_PORT
SANDBOX_DOCKER_HOST=tcp://127.0.0.1:$DIND_PORT
SANDBOX_DATABASE_URL=postgres://dokploy:sandbox@127.0.0.1:$PG_PORT/dokploy
${OIDC_PORT:+SANDBOX_OIDC_ISSUER=http://127.0.0.1:$OIDC_PORT/dokploy}
${HTTP_PORT:+SANDBOX_TRAEFIK_URL=http://127.0.0.1:$HTTP_PORT}
${TRAEFIK_API_PORT:+SANDBOX_TRAEFIK_API=http://127.0.0.1:$TRAEFIK_API_PORT}
${FLEET_KEY:+SANDBOX_FLEET_KEY=$FLEET_KEY}
$(fleet_env)
EOF
}

# Runs a command with only the sandbox environment. DOTENV_CONFIG_PATH keeps
# `-r dotenv/config` from loading apps/dokploy/.env, which may hold real values.
with_env() {
	guard
	[ -f "$ENV_FILE" ] || die "missing $ENV_FILE; run: sandbox.sh up"
	(
		set -a
		# shellcheck disable=SC1090
		. "$ENV_FILE"
		set +a
		export DOTENV_CONFIG_PATH="$ENV_FILE"
		case "$DOCKER_HOST" in tcp://127.0.0.1:*) ;; *) die "DOCKER_HOST is not the sandbox daemon" ;; esac
		"$@"
	)
}

cmd_up() {
	local profiles=()
	for arg in "$@"; do
		case "$arg" in
		--oidc) profiles+=(oidc) ;;
		--traefik) profiles+=(traefik) ;;
		--fleet) profiles+=(fleet) ;;
		*) die "unknown option $arg" ;;
		esac
	done
	mkdir -p "$STATE" "$ROOT/apps/dokploy/.docker/traefik/dynamic"
	# One throwaway key for the sandbox fleet; never leaves this directory.
	[ -f "$STATE/fleet_key" ] ||
		ssh-keygen -q -t ed25519 -N "" -C sandbox-fleet -f "$STATE/fleet_key"
	if [ ! -f "$PORTS_FILE" ]; then
		cat >"$PORTS_FILE" <<EOF
SANDBOX_ID=$SANDBOX_ID
PG_PORT=$(free_port)
REDIS_PORT=$(free_port)
DIND_PORT=$(free_port)
OIDC_PORT=$(free_port)
HTTP_PORT=$(free_port)
TRAEFIK_API_PORT=$(free_port)
APP_PORT=$(free_port)
TRAEFIK_DYNAMIC_DIR=$ROOT/apps/dokploy/.docker/traefik/dynamic
FLEET_KEY=$STATE/fleet_key
FLEET_KEY_PUB=$STATE/fleet_key.pub
EOF
	fi
	load_ports
	COMPOSE_PROFILES=$(
		IFS=,
		echo "${profiles[*]:-}"
	) compose up -d --wait
	guard
	# The app deploys to Swarm, so the sandbox daemon has to be a manager.
	# -H makes this target the throwaway daemon, never the host.
	if [ "$(docker -H "tcp://127.0.0.1:$DIND_PORT" info --format '{{.Swarm.LocalNodeState}}')" != active ]; then
		docker -H "tcp://127.0.0.1:$DIND_PORT" swarm init --advertise-addr 127.0.0.1 >/dev/null
	fi
	# Mirrors initializeNetwork(), which only runs in production.
	docker -H "tcp://127.0.0.1:$DIND_PORT" network inspect dokploy-network >/dev/null 2>&1 ||
		docker -H "tcp://127.0.0.1:$DIND_PORT" network create --driver overlay --attachable dokploy-network >/dev/null
	# The runner image lives inside the sandbox daemon, never on the host.
	if printf %s "${profiles[*]:-}" | grep -q fleet; then
		docker -H "tcp://127.0.0.1:$DIND_PORT" build -q \
			-t dokploy-ansible-runner:sandbox "$ROOT/docker/abhash-ansible-runner" >/dev/null
	fi
	write_app_env
	cmd_status
}

# The fleet containers are reachable from inside the sandbox daemon by IP,
# which is how the Ansible runner (a container there) talks to them.
fleet_env() {
	local ids names=""
	ids=$(docker ps -q --filter "label=$LABEL" --filter "name=fleet-" 2>/dev/null || true)
	[ -n "$ids" ] || return 0
	for id in $ids; do
		local name ip
		name=$(docker inspect -f '{{.Name}}' "$id" | sed 's|^/||')
		ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id" | awk '{print $1}')
		names="$names${names:+,}$name=$ip"
	done
	echo "SANDBOX_FLEET_HOSTS=$names"
	echo "ABHASH_ANSIBLE_RUNNER_IMAGE=dokploy-ansible-runner:sandbox"
}

cmd_status() {
	load_ports
	echo "sandbox $SANDBOX_ID"
	echo "  postgres  127.0.0.1:$PG_PORT"
	echo "  redis     127.0.0.1:$REDIS_PORT"
	echo "  docker    tcp://127.0.0.1:$DIND_PORT"
	echo "  app       http://127.0.0.1:$APP_PORT (sandbox.sh dev)"
	docker ps --filter "label=$LABEL" --format '  {{.Names}}\t{{.Status}}'
}

cmd_down() {
	if [ -f "$PORTS_FILE" ]; then
		load_ports
		compose --profile oidc --profile traefik --profile fleet down -v --remove-orphans
	fi
	local left
	left=$(
		docker ps -aq --filter "label=$LABEL"
		docker network ls -q --filter "label=$LABEL"
		docker volume ls -q --filter "label=$LABEL"
	)
	[ -z "$left" ] || die "resources with label $LABEL are still present: $left"
	rm -rf "$STATE"
	echo "sandbox $SANDBOX_ID removed"
}

cmd="${1:-}"
shift || true
case "$cmd" in
up) cmd_up "$@" ;;
down) cmd_down ;;
status) cmd_status ;;
env) guard && cat "$ENV_FILE" ;;
migrate) with_env pnpm --dir "$ROOT/apps/dokploy" run migration:run ;;
dev) with_env pnpm --dir "$ROOT/apps/dokploy" run dev ;;
test) with_env pnpm --dir "$ROOT/apps/dokploy" exec vitest --config __test__/vitest.config.ts --run "$@" ;;
test:integration) with_env pnpm --dir "$ROOT/apps/dokploy" run test:integration "$@" ;;
exec)
	[ "${1:-}" = "--" ] && shift
	with_env "$@"
	;;
psql) guard && docker exec -it "$(docker ps -q --filter "label=$LABEL" --filter name=postgres)" psql -U dokploy dokploy ;;
setup | dokploy:setup) die "setup initialises Swarm, Traefik and Postgres on the host. Never run it here." ;;
*) sed -n '2,15p' "$0" && exit 1 ;;
esac
