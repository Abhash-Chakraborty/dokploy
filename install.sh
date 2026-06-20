#!/usr/bin/env bash
set -euo pipefail

IMAGE="${DOKPLOY_IMAGE:-ghcr.io/abhash-chakraborty/dokploy:latest}"
STACK_NAME="${DOKPLOY_STACK_NAME:-dokploy}"
APP_PORT="${DOKPLOY_PORT:-3000}"
AUTH_SECRET_NAME="${DOKPLOY_AUTH_SECRET_NAME:-dokploy_better_auth_secret}"
UPDATE_IMAGE="${DOKPLOY_UPDATE_IMAGE:-ghcr.io/abhash-chakraborty/dokploy}"

if ! command -v docker >/dev/null 2>&1; then
	echo "Docker is required before installing this Dokploy fork."
	echo "Install Docker first, then rerun this script."
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "Docker is installed but not reachable by the current user."
	exit 1
fi

if ! docker info --format '{{.Swarm.LocalNodeState}}' | grep -qi active; then
	docker swarm init >/dev/null
fi

docker network create --driver overlay dokploy-network >/dev/null 2>&1 || true

if [ -z "${BETTER_AUTH_URL:-}" ]; then
	if [ -n "${DOKPLOY_URL:-}" ]; then
		BETTER_AUTH_URL="$DOKPLOY_URL"
	else
		SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
		BETTER_AUTH_URL="http://${SERVER_IP:-localhost}:${APP_PORT}"
	fi
fi

if ! docker secret inspect "$AUTH_SECRET_NAME" >/dev/null 2>&1; then
	if command -v openssl >/dev/null 2>&1; then
		AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
	else
		AUTH_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
	fi
	printf "%s" "$AUTH_SECRET" | docker secret create "$AUTH_SECRET_NAME" - >/dev/null
fi

ENV_ARGS=(
	--env "NODE_ENV=production"
	--env "BETTER_AUTH_URL=$BETTER_AUTH_URL"
	--env "BETTER_AUTH_SECRET_FILE=/run/secrets/$AUTH_SECRET_NAME"
	--env "DOKPLOY_UPDATE_IMAGE=$UPDATE_IMAGE"
)

[ -n "${GITHUB_CLIENT_ID:-}" ] && ENV_ARGS+=(--env "GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID")
[ -n "${GITHUB_CLIENT_SECRET:-}" ] && ENV_ARGS+=(--env "GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET")
[ -n "${GOOGLE_CLIENT_ID:-}" ] && ENV_ARGS+=(--env "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID")
[ -n "${GOOGLE_CLIENT_SECRET:-}" ] && ENV_ARGS+=(--env "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET")

docker service rm "$STACK_NAME" >/dev/null 2>&1 || true

docker service create \
	--name "$STACK_NAME" \
	--replicas 1 \
	--publish "${APP_PORT}:3000" \
	--mount type=volume,source=dokploy-data,target=/app/apps/dokploy/.docker \
	--secret source="$AUTH_SECRET_NAME",target="$AUTH_SECRET_NAME" \
	"${ENV_ARGS[@]}" \
	"$IMAGE"

echo "Abhash Dokploy fork is starting on port ${APP_PORT}."
echo "Better Auth URL: ${BETTER_AUTH_URL}"
echo "Image: ${IMAGE}"
