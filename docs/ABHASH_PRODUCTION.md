# Abhash Dokploy Production Notes

This fork is intended to run as Abhash's personal self-hosted Dokploy image.
It does not require a Dokploy Enterprise license for the Abhash-owned audit log,
license, SSO, whitelabeling, or custom role changes in this fork.

## Required Production Environment

Set these on the `dokploy` Docker service:

```bash
BETTER_AUTH_URL=https://your-dokploy-domain.example.com
BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_better_auth_secret
DOKPLOY_UPDATE_IMAGE=ghcr.io/abhash-chakraborty/dokploy
NODE_ENV=production
```

`BETTER_AUTH_URL` must be the public HTTPS URL users open in the browser. It is
used by Better Auth to create OAuth callback URLs and cookies.

Create the Better Auth secret once and keep it stable:

```bash
openssl rand -base64 48 | docker secret create dokploy_better_auth_secret -
```

Then attach it to the service:

```bash
docker service update \
  --secret-add source=dokploy_better_auth_secret,target=dokploy_better_auth_secret \
  --env-add BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_better_auth_secret \
  --env-add BETTER_AUTH_URL=https://your-dokploy-domain.example.com \
  --env-add DOKPLOY_UPDATE_IMAGE=ghcr.io/abhash-chakraborty/dokploy \
  dokploy
```

Do not rotate `BETTER_AUTH_SECRET` casually. Rotating it can invalidate auth
state. If you rotate it, do it intentionally during a maintenance window.

## Optional Google and GitHub Login

Set these only after creating OAuth apps:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

OAuth callback URLs:

```text
https://your-dokploy-domain.example.com/api/auth/callback/github
https://your-dokploy-domain.example.com/api/auth/callback/google
```

The login page shows GitHub and Google buttons only when the matching client ID
and secret are configured.

## Safe Migration From Official Dokploy

Do not reinstall from scratch on the existing production host.

The safe path is to update the existing Docker service image so the current
Postgres data, Docker volumes, remote server records, projects, and deployments
stay intact:

```bash
docker service update \
  --image ghcr.io/abhash-chakraborty/dokploy:latest \
  --env-add DOKPLOY_UPDATE_IMAGE=ghcr.io/abhash-chakraborty/dokploy \
  dokploy
```

Before doing that:

1. Confirm the new image has been published by the GitHub release workflow.
2. Take a database backup.
3. Save the current image for rollback:

```bash
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Rollback is the same command with the old image:

```bash
docker service update --image OLD_IMAGE_FROM_INSPECT dokploy
```

## Local Production Build

Use the root command:

```bash
pnpm run dokploy:build
```

The root build now builds `@dokploy/server` first, then builds the Dokploy app.
That avoids runtime errors where the app starts against the server package source
entry instead of the production `dist` entry.

For local production start, make sure `apps/dokploy/.env` has at least:

```bash
DATABASE_URL=postgres://...
PORT=3000
NODE_ENV=production
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
DOKPLOY_UPDATE_IMAGE=ghcr.io/abhash-chakraborty/dokploy
```

Then run:

```bash
pnpm run dokploy:start
```

## Updating From This Fork

The webserver update flow checks and updates against:

```text
ghcr.io/abhash-chakraborty/dokploy
```

Override with:

```bash
DOKPLOY_UPDATE_IMAGE=ghcr.io/your-owner/your-image
```

The release workflow publishes a new `latest` image only after changes land on
`main`.
