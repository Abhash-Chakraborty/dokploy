#!/usr/bin/env bash
# Installer regression test (issue #20), run inside a throwaway, labelled
# Docker-in-Docker "host" so it never touches the machine's own Docker.
#
#   scripts/sandbox/install-test.sh            repair an install made by the old
#                                              installer, then re-run it
#   scripts/sandbox/install-test.sh --fresh    install on an empty host
#
# DOKPLOY_IMAGE picks the image under test (default :latest).
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
IMAGE="${DOKPLOY_IMAGE:-ghcr.io/abhash-chakraborty/dokploy:latest}"
HOST="dkp-sbx-install-$$"
FRESH="${1:-}"

step() { printf '\n\033[0;34m== %s\033[0m\n' "$*"; }
fail() {
	printf '\033[0;31mFAIL\033[0m %s\n' "$*" >&2
	on_host docker service ls >&2 || true
	on_host docker service logs --tail 30 dokploy >&2 || true
	exit 1
}
ok() { printf '\033[0;32mok\033[0m   %s\n' "$*"; }
on_host() { docker exec "$HOST" "$@"; }

cleanup() { docker rm -f -v "$HOST" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step "Starting a disposable host"
docker run -d --privileged --name "$HOST" \
	--label "com.abhash.sandbox=install-test" \
	docker:28-dind >/dev/null
for _ in $(seq 1 60); do on_host docker info >/dev/null 2>&1 && break; sleep 1; done
on_host apk add --no-cache -q bash curl openssl iproute2 >/dev/null
# docker:dind is itself a container; the installer refuses to run in one.
on_host rm -f /.dockerenv
docker cp "$ROOT/install.sh" "$HOST:/install.sh"

if [ "$FRESH" != "--fresh" ]; then
	step "Reproducing issue #20 with the previous installer"
	git -C "$ROOT" show 256f6a233:install.sh >"/tmp/$HOST-old-install.sh"
	docker cp "/tmp/$HOST-old-install.sh" "$HOST:/old-install.sh"
	rm -f "/tmp/$HOST-old-install.sh"
	# The issue's step 3. The old installer's own check matched "inactive"
	# against "active" and never initialised the swarm.
	on_host docker swarm init >/dev/null
	# It creates the service without --detach, so it waits for a service that
	# never converges. The broken state exists well before this limit.
	on_host timeout 120 env DOKPLOY_IMAGE="$IMAGE" bash /old-install.sh >/dev/null 2>&1 || true
	on_host docker service inspect dokploy >/dev/null 2>&1 ||
		fail "the old installer did not create the dokploy service"
	on_host docker service inspect dokploy-postgres >/dev/null 2>&1 &&
		fail "the old installer was expected to leave Postgres out"
	ok "old installer left dokploy without Postgres, as reported"
fi

step "Running the installer"
on_host env DOKPLOY_IMAGE="$IMAGE" bash /install.sh || fail "installer exited non-zero"

replicas() {
	on_host docker service ls --filter "name=$1" --format '{{.Name}} {{.Replicas}}' |
		awk -v n="$1" '$1 == n {print $2}'
}

check_install() {
	for svc in dokploy dokploy-postgres dokploy-redis; do
		[ "$(replicas "$svc")" = "1/1" ] || fail "$svc is $(replicas "$svc"), expected 1/1"
	done
	ok "dokploy, dokploy-postgres and dokploy-redis are 1/1"

	on_host curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null ||
		fail "health endpoint did not answer"
	ok "Dokploy answers on :3000"

	on_host docker service inspect dokploy \
		--format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' |
		grep -q "$(on_host docker network inspect -f '{{.ID}}' dokploy-network)" ||
		fail "dokploy is not attached to dokploy-network"
	[ "$(on_host docker network inspect -f '{{.Attachable}}' dokploy-network)" = "true" ] ||
		fail "dokploy-network is not attachable"
	ok "dokploy is on the attachable dokploy-network"

	if on_host docker service logs dokploy 2>&1 | grep -q "DEPRECATED DATABASE CONFIG"; then
		fail "Dokploy still uses the hardcoded database credentials"
	fi
	ok "database credentials come from the Docker secret"

	[ "$(on_host docker inspect -f '{{.State.Running}}' dokploy-traefik)" = "true" ] ||
		fail "Traefik is not running"
	ok "Traefik is running"
}
check_install

step "Re-running the installer"
before=$(on_host docker secret inspect -f '{{.ID}}' dokploy_postgres_password)
on_host env DOKPLOY_IMAGE="$IMAGE" bash /install.sh >/dev/null || fail "re-run exited non-zero"
after=$(on_host docker secret inspect -f '{{.ID}}' dokploy_postgres_password)
[ "$before" = "$after" ] || fail "the database secret was replaced on re-run"
check_install
ok "re-running keeps the secrets and the install healthy"

printf '\n\033[0;32mInstaller regression test passed.\033[0m\n'
