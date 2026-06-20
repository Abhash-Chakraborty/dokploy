#!/usr/bin/env bash
set -euo pipefail

IMAGE="${DOKPLOY_IMAGE:-ghcr.io/abhash-chakraborty/dokploy:latest}"
STACK_NAME="${DOKPLOY_STACK_NAME:-dokploy}"
APP_PORT="${DOKPLOY_PORT:-3000}"

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

docker service rm "$STACK_NAME" >/dev/null 2>&1 || true

docker service create \
	--name "$STACK_NAME" \
	--replicas 1 \
	--publish "${APP_PORT}:3000" \
	--mount type=volume,source=dokploy-data,target=/app/apps/dokploy/.docker \
	--env NODE_ENV=production \
	"$IMAGE"

echo "Abhash Dokploy fork is starting on port ${APP_PORT}."
echo "Image: ${IMAGE}"
