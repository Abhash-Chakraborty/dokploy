#!/usr/bin/env bash
# Rehearses an upgrade against a copy of production, inside the sandbox.
#
# It answers the three questions that matter before you deploy:
#   1. do the new migrations apply to the real data?
#   2. are they idempotent, so a re-run is a no-op?
#   3. does the image you are running now still work on the migrated
#      database — that is, can you roll back?
#
#   upgrade-rehearsal.sh <prod-dump.sql> [previous-image]
#
# Take the dump read-only, e.g.
#   docker exec "$(docker ps -q -f name=dokploy-postgres)" \
#     pg_dump -U dokploy -Fc dokploy > /tmp/prod.dump
set -euo pipefail

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DUMP=${1:?usage: upgrade-rehearsal.sh <prod-dump> [previous-image]}
PREVIOUS_IMAGE=${2:-ghcr.io/abhash-chakraborty/dokploy:v0.30.4}
SANDBOX="$ROOT/scripts/sandbox/sandbox.sh"

[ -f "$DUMP" ] || { echo "rehearsal: no such dump: $DUMP" >&2; exit 1; }

step() { printf '\n== %s\n' "$1"; }

step "Starting the sandbox"
"$SANDBOX" up >/dev/null
# shellcheck disable=SC1091
. "$ROOT/.sandbox/ports.env"
PG=$(docker ps -q --filter "label=com.abhash.sandbox=$SANDBOX_ID" --filter name=postgres)
[ -n "$PG" ] || { echo "rehearsal: the sandbox database is not running" >&2; exit 1; }

step "Restoring the production copy"
# The drizzle schema goes too: the rehearsal has to start from production's
# migration state, not the sandbox's.
docker exec -i "$PG" psql -U dokploy -q -d dokploy \
	-c 'drop schema if exists public cascade; create schema public;' \
	-c 'drop schema if exists drizzle cascade;' >/dev/null
if head -c 5 "$DUMP" | grep -q 'PGDMP'; then
	docker exec -i "$PG" pg_restore -U dokploy -d dokploy --no-owner --no-acl < "$DUMP" >/dev/null
else
	docker exec -i "$PG" psql -U dokploy -q -d dokploy < "$DUMP" >/dev/null
fi
BEFORE=$(docker exec "$PG" psql -U dokploy -d dokploy -tAc \
	"select count(*) from information_schema.tables where table_schema='public'")
echo "restored $BEFORE tables"

step "Applying the new migrations"
"$SANDBOX" migrate >/dev/null
step "Applying them again (they must be idempotent)"
"$SANDBOX" migrate >/dev/null
AFTER=$(docker exec "$PG" psql -U dokploy -d dokploy -tAc \
	"select count(*) from information_schema.tables where table_schema='public'")
echo "now $AFTER tables"
[ "$AFTER" -ge "$BEFORE" ] || { echo "rehearsal: tables disappeared" >&2; exit 1; }

step "Checking your data survived"
for table in project application compose "user" member server; do
	COUNT=$(docker exec "$PG" psql -U dokploy -d dokploy -tAc \
		"select count(*) from \"$table\"" 2>/dev/null || echo skip)
	echo "  $table: $COUNT"
done

step "Booting the image you run now, against the migrated database ($PREVIOUS_IMAGE)"
ROLLBACK_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
NAME="dkp-sbx-$SANDBOX_ID-rollback"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# On the sandbox network, reaching the throwaway database by name, and
# published only to loopback: the real Dokploy owns port 3000 on the host
# and must not be disturbed.
NETWORK="dkp-sbx-${SANDBOX_ID}_default"
docker run -d --name "$NAME" \
	--label "com.abhash.sandbox=$SANDBOX_ID" \
	--network "$NETWORK" \
	-p "127.0.0.1:$ROLLBACK_PORT:3000" \
	-e "DATABASE_URL=postgres://dokploy:sandbox@postgres:5432/dokploy" \
	-e "REDIS_URL=redis://redis:6379" \
	-e "BETTER_AUTH_SECRET=rehearsal-secret" \
	-e "BETTER_AUTH_URL=http://127.0.0.1:$ROLLBACK_PORT" \
	"$PREVIOUS_IMAGE" >/dev/null

OK=no
for _ in $(seq 1 60); do
	CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ROLLBACK_PORT/" || true)
	case "$CODE" in 200 | 302 | 307) OK=yes; break ;; esac
	sleep 3
done
docker logs --tail 20 "$NAME" 2>&1 | sed 's/^/  /'
docker rm -f "$NAME" >/dev/null

if [ "$OK" = yes ]; then
	echo
	echo "PASS: the migrations apply to production data, re-apply cleanly, and"
	echo "      the previous image still serves on the migrated database."
else
	echo
	echo "FAIL: the previous image did not come up on the migrated database." >&2
	echo "      Do not deploy until that is understood: rollback would not work." >&2
	exit 1
fi
