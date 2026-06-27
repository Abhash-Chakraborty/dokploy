# Building & Deploying the ARM64 Dokploy Image

## Why ARM64 matters

The production server (`abhash-arm` / `abhash-ampere-24gb`) is `linux/arm64/v8`.
A Docker image only runs on a platform that exists in its manifest. If the
GHCR manifest contains only `linux/amd64`, the ARM server cannot pull it and
fails with:

```
no matching manifest for linux/arm64/v8 in the manifest list entries:
no match for platform in manifest: not found
```

**Root cause of the original failure:** the image tag existed on GHCR, but the
manifest did not include `linux/arm64/v8`. The release workflow built only
`linux/amd64` on push (arm64 was gated behind a manual `include_arm64` input),
so `:latest` had no ARM build for the server to pull.

## Why `:latest` alone is risky — use SHA tags

`:latest` is mutable: it moves every build, so you can't tell which code is
running and rollback is guesswork. Each build also publishes an immutable
`:sha-<short-git-sha>` tag. **Deploy the SHA tag** — it pins an exact commit and
makes rollback deterministic.

## How to build (one-click, local, Windows)

```powershell
# Requires Docker Desktop running + `docker login ghcr.io` (or set $env:GHCR_TOKEN)
./scripts/build-dokploy-arm64.ps1
```

The script builds multi-arch (`linux/amd64,linux/arm64`) from the repo root,
pushes `:latest` and `:sha-<short-sha>`, and **fails if arm64 is missing** from
the pushed manifest. If multi-arch fails on your machine, fall back to ARM-only:

```powershell
./scripts/build-dokploy-arm64.ps1 -ArmOnly
```

### Or let CI build it
Pushing to `main` or `abhash-dokploy` triggers `.github/workflows/personal-ghcr-release.yml`,
which now builds `linux/amd64,linux/arm64` on every run and publishes
`:latest`, `:<version>`, and `:sha-<sha>`.

## How to deploy to the ARM server

```powershell
./scripts/deploy-dokploy-arm.ps1            # deploys :sha-<current-commit>
./scripts/deploy-dokploy-arm.ps1 -Tag latest
```

The deploy script updates **only** the `dokploy` Swarm service. It does not
touch `dokploy-postgres`, `dokploy-redis`, `dokploy-traefik`, or
`dokploy-network-holder`. It captures the current image first (for rollback),
pulls, force-updates, shows rollout status + logs, and curls the public URL.

## How to verify the GHCR manifest

```powershell
docker buildx imagetools inspect ghcr.io/abhash-chakraborty/dokploy:latest
$sha = git rev-parse --short HEAD
docker buildx imagetools inspect "ghcr.io/abhash-chakraborty/dokploy:sha-$sha"
```

Both outputs must list `linux/arm64` under Platform.

## How to verify the Swarm rollout

```bash
docker service ps dokploy --no-trunc          # newest task should be Running
docker service logs dokploy --since 5m --tail 200
curl -k -sS -L -o /dev/null -w 'HTTP=%{http_code}\n' https://dokploy.abhashchakraborty.tech/
```

The HTTP check should return `HTTP=200`.

## How to rollback

Capture the current image **before** deploying (the deploy script prints it):

```bash
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Roll back the `dokploy` service only:

```bash
docker service update --with-registry-auth --force \
  --image ghcr.io/abhash-chakraborty/dokploy:sha-<previous-sha> dokploy
```

Do **not** restart postgres / redis / traefik / network-holder during rollback.
