# Abhash Dokploy Fork

This branch is a personal fork of [Dokploy](https://github.com/dokploy/dokploy), tailored for Abhash's self-hosted usage.

The goal is to keep the fork close to upstream while carrying a small number of personal changes:

- publish personal Docker images to GitHub Container Registry;
- provide a personal installer endpoint;
- keep up with upstream `dokploy/dokploy:canary`;
- keep enterprise/proprietary licensing boundaries explicit.

## Branches

- `main`: production and default branch. Every push that changes app code
  runs the Personal GHCR Release workflow, which builds the multi-arch image
  and, when `apps/dokploy/package.json` carries a version with no GitHub
  release yet, tags it `:<version>` and `:latest` and cuts the release.
- `sync/upstream`: bot-owned. The nightly sync recreates it from `main`,
  merges `upstream/canary` into it and opens a PR into `main`. Never commit
  to it by hand; it is force-pushed.
- Feature and fix work goes on short-lived branches (`feat/...`, `fix/...`,
  `perf/...`) merged into `main` by PR.
- `master`, `canary`, `abhash-dokploy`, `feat/dokploy-improvements` and
  `codex/release-v0.29.12` are historical and fully contained in `main`.

The fork's version tracks upstream's released version. A fork-only patch
release bumps the patch number; the next upstream merge takes upstream's
version again.

## Local Setup

The development checkout lives on the production server, so everything runs
against a disposable sandbox rather than the host Docker. See the isolation
rules in `CLAUDE.md`. Never run `pnpm run dokploy:setup` here: it initialises
Swarm, networks, Traefik and Postgres on the host.

```bash
pnpm install
scripts/sandbox/sandbox.sh up          # Postgres, Redis, Docker-in-Docker (+ --oidc, --traefik)
scripts/sandbox/sandbox.sh migrate
scripts/sandbox/sandbox.sh dev         # app on the printed 127.0.0.1 port
scripts/sandbox/sandbox.sh test        # full suite, real-Docker tests included
scripts/sandbox/sandbox.sh down        # removes only com.abhash.sandbox resources
```

A plain `pnpm test` is also safe: outside the sandbox it points Docker at a
closed port, so suites that need a daemon skip.

To rehearse migrations on real data, restore a production dump into the
sandbox with `scripts/sandbox/restore-prod-copy.sh <dump>`.

## Upstream Sync

This fork expects an `upstream` remote:

```bash
git remote add upstream https://github.com/dokploy/dokploy.git
git remote set-url --push upstream DISABLED
git config rerere.enabled true
git config rerere.autoupdate true
```

`rerere` lets Git remember conflict resolutions, which pays off because
upstream repeatedly touches the same files the fork restyled.

`.github/workflows/sync-upstream.yml` runs nightly. It merges (never rebases)
`upstream/canary` into `sync/upstream`, opens a PR into `main` and dispatches
CI on that branch. If the merge conflicts it fails with the conflicting paths
in the job summary; resolve locally:

```bash
git fetch upstream canary
git switch -c merge/upstream-vX.Y.Z main
git merge upstream/canary
# resolve, verify, then merge into main
```

Recurring conflict patterns and how they have been resolved:

- **Migrations.** Upstream keeps claiming the next migration indices. Keep
  upstream's files untouched and renumber the fork's past them, with
  `when` timestamps after upstream's last entry, and make the fork's SQL
  idempotent (`IF NOT EXISTS`, `duplicate_object` guards) so databases that
  already ran the old number re-apply it as a no-op. CI runs
  `drizzle-kit check` and fails on schema drift or duplicate indices.
- **Settings and service pages.** Keep the fork's edge-to-edge
  `PageContainer`/`PageHeader` layout and port upstream's functional changes
  into it.
- **SSO.** Removed from this fork; drop upstream's SSO pages, dialogs and
  enforcement hooks when they reappear.
- **Enterprise gating.** The fork runs these features unlicensed through its
  own `abhash` routers and services; check new upstream code paths that call
  the licence-gated `proprietary` helpers.

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

## Personal Feature Additions

This fork carries a UI/UX overhaul and several feature additions on top of
upstream Dokploy. Highlights:

### Navigation & layout
- The sidebar shows only top-level sections (Home, Projects, Deployments,
  Monitoring, Schedules, Docker, **Terminals**, Swarm, Requests). All settings
  and help links moved into the user-avatar dropdown.
- Pages are edge-to-edge (no boxed "canvas"); each page uses a shared
  `PageHeader` with its primary action consolidated top-right
  (`components/shared/page-header.tsx`).
- A thin version footer (`V x.y`) appears on every dashboard page.

### Terminals
- A top-level **Terminals** page (`/dashboard/terminals`) acts as a master
  console with a server selector, defaulting to the local Dokploy server.
- `components/shared/terminal-panel.tsx` provides a slide-over terminal usable
  anywhere; both reuse the existing xterm `TerminalView`.

### Authentication
- **2FA** enable/verify no longer hangs — login hard-navigates so the session
  cookie reaches the dashboard, and enable/disable await the user refetch.
- **Passkeys (WebAuthn)** via the Better Auth `passkey` plugin. Register/manage
  passkeys on the profile page; sign in with a passkey on the login page. The
  `passkey` table is created by migration `0173_add_passkey`.
- **Per-method login toggles** (email+password, GitHub, Google, passkey) on the
  Web Server settings page. At least one method must stay enabled — enforced in
  `authMethodsConfigSchema` and surfaced via `settings.getAuthMethods`. Migration
  `0174_add_auth_methods`.
- **Login history** (IP + device) is shown read-only on the profile page,
  sourced from Better Auth sessions via `user.getLoginHistory`.

### Scheduling
- New schedules default the timezone picker to the browser's local timezone
  instead of UTC.

### Backups
- A unified **Backups** page (`/dashboard/settings/backups`) aggregates every
  backup across service types with status/schedule/destination and a status
  filter, via `backup.listAll`.

### AI assistant
- A right-side **AI sidebar** (`components/shared/ai-sidebar.tsx`) provides a
  page-context-aware, permission-scoped (read / write / debug) assistant that is
  advisory only — it proposes confirmable steps and never executes actions. It
  reuses the existing AI provider settings.

### Tags
- The tag selector lets you create a tag inline by typing a name that does not
  exist yet ("+ Create …"), available everywhere the selector is used.

### Migrations
Two new migrations ship with this fork and run automatically on startup:
`0173_add_passkey` and `0174_add_auth_methods`. No manual step is required.

