#!/usr/bin/env bash
# Restores a pg_dump (custom format) of production into the *sandbox*
# Postgres, to rehearse migrations against real data:
#
#   docker exec <prod-postgres-container> pg_dump -U dokploy -Fc dokploy > /secure/dokploy.dump
#   scripts/sandbox/restore-prod-copy.sh /secure/dokploy.dump
#   scripts/sandbox/sandbox.sh migrate
#
# The dump holds production secrets: keep it out of the repo and delete it
# when done. Only the sandbox container is ever written to.
set -euo pipefail
dump=${1:?usage: restore-prod-copy.sh <dump-file>}
[ -r "$dump" ] || { echo "cannot read $dump" >&2; exit 1; }
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
SANDBOX_ID=${SANDBOX_ID:-$(printf %s "$ROOT" | sha1sum | cut -c1-8)}
pg=$(docker ps -q --filter "label=com.abhash.sandbox=$SANDBOX_ID" --filter name=postgres)
[ -n "$pg" ] || { echo "sandbox Postgres is not running; run sandbox.sh up" >&2; exit 1; }
docker exec -i "$pg" pg_restore -U dokploy -d dokploy --clean --if-exists --no-owner --no-privileges <"$dump"
echo "restored $dump into sandbox $SANDBOX_ID"
