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

