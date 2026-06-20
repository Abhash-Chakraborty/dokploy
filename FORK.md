# Abhash Dokploy Fork

This branch is a personal fork of [Dokploy](https://github.com/dokploy/dokploy), tailored for Abhash's self-hosted usage.

The goal is to keep the fork close to upstream while carrying a small number of personal changes:

- publish personal Docker images to GitHub Container Registry;
- provide a personal installer endpoint;
- keep up with upstream `dokploy/dokploy:canary`;
- keep enterprise/proprietary licensing boundaries explicit.

## Branches

- `canary`: upstream tracking base from Dokploy.
- `abhash-dokploy`: personal customization branch.

When you are ready to make this the long-lived branch in GitHub, push it and set it as the repository default branch.

## Local Setup

```bash
pnpm install
cp apps/dokploy/.env.example apps/dokploy/.env
pnpm run dokploy:setup
pnpm run server:script
pnpm run dokploy:dev
```

On Windows, `dokploy:setup` has been made cross-platform by replacing the shell-only `sleep` command with a short Node wait.

## Upstream Sync

This fork expects an `upstream` remote:

```bash
git remote add upstream https://github.com/dokploy/dokploy.git
git remote set-url --push upstream DISABLED
git config rerere.enabled true
git config rerere.autoupdate true
```

`rerere` lets Git remember conflict resolutions. It will not solve every conflict, but it helps when upstream repeatedly touches the same areas.

The GitHub workflow `.github/workflows/sync-upstream.yml` can periodically merge `upstream/canary` into your personal branch. If conflicts happen, the workflow opens an issue so you can fix them manually.

## Licensing Note

Dokploy's root `LICENSE.MD` says content under any `/proprietary` directory is covered by `LICENSE_PROPRIETARY.md`; other content is Apache-2.0. This checkout contains proprietary directories, including audit-log code. Treat those files as source-available under Dokploy's proprietary terms unless you replace them with a clean implementation outside proprietary paths.

For personal use, decide whether you want to:

- keep the existing source-available proprietary code only in your private/personal deployment; or
- reimplement audit logs in non-proprietary paths with your own Apache-compatible code.

## Personal Installer

After pushing this branch and enabling GitHub Pages or another static host, expose `install.sh` at your domain, for example:

```bash
curl -sSL https://abhashchakraborty.tech/install.sh | bash
```

The script defaults to:

```text
ghcr.io/abhash-chakraborty/dokploy:latest
```

You can override it:

```bash
DOKPLOY_IMAGE=ghcr.io/abhash-chakraborty/dokploy:canary bash install.sh
```
