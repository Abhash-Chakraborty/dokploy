# Abhash Dokploy Fork

This branch is a personal fork of [Dokploy](https://github.com/dokploy/dokploy), tailored for Abhash's self-hosted usage.

The goal is to keep the fork close to upstream while carrying a small number of personal changes:

- publish personal Docker images to GitHub Container Registry;
- provide a personal installer endpoint;
- keep up with upstream `dokploy/dokploy:canary`;
- keep enterprise/proprietary licensing boundaries explicit.

## Branches

- `master`: integration branch. The upstream sync workflow rebases this branch onto `dokploy/dokploy:canary` and opens a PR into `main` when it succeeds.
- `main`: production branch. Merging a release PR here publishes the production GHCR image tagged `latest` and with the Dokploy version.
- `abhash-dokploy`: setup branch used to bootstrap this fork.

Set `main` as the repository default branch once it is pushed.

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

The GitHub workflow `.github/workflows/sync-upstream.yml` periodically rebases `master` onto `upstream/canary` with Git's `rerere` conflict memory enabled and a `-X theirs` retry preference for replaying fork changes. If the rebase succeeds and `master` is ahead of `main`, it opens a release PR into `main`. If conflicts remain, the workflow opens an issue so you can fix them manually.

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
