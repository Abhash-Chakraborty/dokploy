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

Dokploy's root `LICENSE.MD` says content under any `/proprietary` directory is
covered by `LICENSE_PROPRIETARY.md`; other content is Apache-2.0. This fork
does not use that code: everything it needs (custom roles, whitelabeling,
entitlements, SSO, SCIM, forward auth) is implemented under `abhash` paths.
`/proprietary` stays in the tree only to keep upstream merges clean; it is
excluded from typechecking and from the Docker build context, and CI
(`scripts/check-no-proprietary-imports.mjs`) fails on any import from it.

## Personal Installer

Run as root on a Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/Abhash-Chakraborty/dokploy/main/install.sh | sudo bash
```

It installs Docker if needed, initialises Swarm, and provisions the attachable
`dokploy-network`, `dokploy-postgres` and `dokploy-redis` services, Docker
secrets for the database password and auth secret, the `dokploy` service and
Traefik. Re-running it reuses existing secrets and volumes and repairs a
half-finished install; `install.sh update` only rolls the image.

Overrides, e.g. a canary image or a public URL:

```bash
curl -fsSL .../install.sh | sudo DOKPLOY_IMAGE=ghcr.io/abhash-chakraborty/dokploy:canary DOKPLOY_URL=https://dokploy.example.com bash
```

`scripts/sandbox/install-test.sh` runs the installer end to end in a
throwaway Docker-in-Docker host, including repairing an install made by the
previous installer (issue #20); CI runs it whenever the installer changes.

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

### Organizations, access and identity
All under Settings. Each capability is off until the owner turns it on.
- **Members & access**: teams, and roles per project, environment or service
  (Viewer, Developer, Project admin, or a custom role) for people and
  teams. Existing access carries over exactly when the engine is turned on
  (`abhash_role_binding`, `services/abhash/rbac`). Suspend and reactivate
  members; role pinning; an effective-access explainer.
- **Authentication**: login methods enforced by the server; single sign-on
  with Authentik or any OpenID Connect provider, with organization role and
  teams taken from IdP groups on every sign-in; enforce SSO with an owner
  break-glass (`pnpm run reset-sso` in the container undoes a lockout).
- **Provisioning (SCIM)**: users and groups pushed by Authentik; groups
  become teams; deactivation and deletion suspend.
- **Protect apps**: Traefik forward-auth gates (Authentik outpost or any
  forward-auth service) chosen per domain.

### Background jobs
Off until the owner turns it on from **Activity** in the sidebar. A durable
job engine (`services/abhash/jobs`) on BullMQ, using the existing
`dokploy-redis` (no new setting: `REDIS_URL` falls back to it). Every job is a
row in `abhash_job` with its actor, status, result and a log under
`logs/abhash-jobs`; Redis only carries the work in flight, so a flushed Redis
loses nothing but pending jobs. Jobs are never re-run after a crash: rows left
running become "interrupted". Per-key semaphores (`locks.ts`) keep, for
example, one firewall change per server. New job types register with
`defineJob` in `registry.ts`. If Redis is unreachable only jobs pause;
deploys and upstream schedules do not depend on it.

### Vault
Off until the owner turns it on (Settings -> Sources & Secrets -> Vault).
Secrets are stored per version with envelope encryption: a data key per
version encrypts the value, the instance master key only wraps data keys, and
the AAD binds both to the secret and version. The master key lives in
`<BASE_PATH>/abhash/vault-keyring.json` (root-only), can be rotated without
decrypting anything, and is exported as a passphrase-sealed **recovery kit**
— losing it loses every secret. People and agents see only a secret's name,
description and scope; the value is write-only, and only the owner can reveal
it, with their password and an audit entry. Reference a secret anywhere env
vars are resolved with `${{secret.NAME}}`: the closest scope wins
(environment, then project, then organization), resolution happens at deploy
time in `resolveVaultReferences`, and usage is recorded per environment.

**Encrypt stored credentials** (same page, owner only) turns the ~30
credential columns upstream keeps in plain text — SSH keys, S3 and registry
credentials, git tokens, notification tokens, database passwords,
`vault_provider.config` — into the same `enc:v1:` format upstream already
uses for env vars (`db/schema/abhash-credential.ts`). It is reversible:
turning it off converts every value back, which is what keeps a rollback to
an older image possible.

### Agents and approvals
Settings -> Organization -> Agents. An agent is a service account (a user row
with no login method) that gets access the same way a person does, through
teams and per-project roles. Each API key can be **read-only**, limited to
named procedures (`project.*`) and to source addresses, and given an
**approval mode**. Requests from a key are tagged with an actor
(`services/abhash/agents/actor.ts`), which the audit log records and which
drives two guards in `trpc.ts`:
- the key's own limits, checked before the procedure runs;
- **credential redaction** on everything returned to a key or agent —
  environment variables keep their names but lose their values,
  `${{secret.X}}` references stay readable, and credential fields are
  masked. This closes the MCP `get_application` hole, since MCP calls run
  through the same context.

Destructive jobs an agent asks for become an **approval** a person decides
(`abhashJobs.run` -> `enqueueJobForActor`). Approving runs exactly the
recorded request, attributed to both the agent and the approver; an agent
can never approve its own request.

### Ansible
Settings -> Organization -> Ansible, off until the job engine is on. Playbooks
live in projects (a small in-database file tree) and a "run" ties a playbook
to servers, variables and an optional schedule. Each run:
- happens in a **throwaway container** from the pinned runner image
  (`docker/abhash-ansible-runner`, published by CI) — Dokploy itself never
  carries Ansible, restic or rclone;
- gets a generated inventory and per-host keys copied into a scratch volume,
  so it works the same against a local, remote or sandbox Docker daemon;
- **pins host keys** read over a real SSH handshake before it starts, so
  host-key checking stays on;
- defaults to **check mode**: only an apply is treated as destructive, and
  only an apply needs approval when an agent asks for it.

`sandbox.sh up --fleet` starts three throwaway Ubuntu servers with sshd, so
these runs, and later the bootstrap, mesh and firewall work, are tested for
real and for idempotency without touching anything outside the sandbox.

### Fleet: SSH layer and inventory
Off until `fleet.ssh` is on. `services/abhash/ssh` replaces one-connection-
per-command with a pool: connections are reused and closed when idle,
concurrent commands per server are capped and retried when sshd runs out of
sessions, every command has a timeout and can be cancelled, and the exit
code comes back instead of an exception. Upstream's `execAsyncRemote` routes
through it with a one-line hook, so every existing feature benefits.

**Host keys are trusted on first use and then enforced.** A changed key
blocks the connection, flags the server and needs an admin to accept it.

`abhash_server_meta` adds what the command centre needs: tags, a group, an
environment label, whether to connect over the public address or the mesh,
the pinned host key, health and facts. A `fleet.collect-facts` job runs every
five minutes, in one SSH round trip per server, and marks a server online,
degraded (for example a nearly full disk) or offline.

### Command centre
`/dashboard/command-center` (admins, self-hosted). One table of every server
with health, facts, tags, environment label and host-key state, and the
actions that keep them running — all of them jobs you can follow and cancel:
- **Run command** across servers, in batches, one at a time or all at once,
  with stop-on-failure and per-server output in the job log. A command that
  can destroy a machine has to be confirmed by typing the server count.
- **Apply baseline**: sshd hardening (written as a validated drop-in, then
  proven by reconnecting), unattended upgrades, fail2ban, kernel tuning and
  journal limits, from the shipped `Dokploy platform` playbooks.
- **Reclaim disk** and **Patch** (rolling, reboot only if the server asks
  for one).
- **Accept new key** when a server's host key changed.
A bootstrap job can also run upstream's Docker/Swarm/Traefik setup and then
validate the result.

### Secure network (mesh)
Infrastructure -> Secure network. **NetBird (self-hosted) is the primary
provider**; the Tailscale client with **Headscale** is a thin alternative.
Exactly one provider is active per organization, enforced by a partial
unique index, and switching is a deliberate action.

- The API token is never stored: the provider holds a `${{secret.NAME}}`
  reference and the value is read from the vault per call.
- Dokploy creates only objects whose name starts with the configured prefix
  (`dokploy-`), so an existing NetBird keeps its own groups, policies and
  peers. **Preview changes** shows the plan before anything is created.
- Enrollment uses a single-use key that expires in an hour, with the client
  installed over SSH; DNS management is off by default so container DNS is
  untouched, and the server's own SSH server in the mesh is disabled.
- Joining can switch Dokploy's SSH to the mesh address, but only after
  proving a connection works over it; otherwise it falls back. Leaving moves
  back to the public address first, so the job never cuts its own path.
- Servers already in the mesh are **adopted** by matching peers, which is how
  the machine Dokploy runs on is picked up without re-enrolling it.
- Headscale policy is snippet-only: Dokploy shows the grants to paste and
  never writes your policy file.

Tested against a stand-in provider API end to end (vault token, plan, the
one-active rule, adoption) and with client-level tests for the request
shapes and join commands. Enrolling a real host is exercised at rollout.

### Firewall
Infrastructure -> Firewall, per server, in one of three modes: **off**
(untouched), **audit** (rules worked out and shown, never applied) or
**enforce**. Rules are derived from what the server actually runs — SSH from
the mesh (or rate-limited when there is none), 80/443 where Traefik runs,
Swarm ports only between servers, the metrics port only from Dokploy, and a
database's published port only from the mesh — each with a reason you can
switch off, plus any rules you write.

- **Published container ports are really filtered.** Docker writes its own
  iptables rules that never pass ufw's INPUT chain, so Dokploy keeps a
  `DOKPLOY-FW` chain called from `DOCKER-USER`, matching on
  `--ctorigdstport`, which is the port the client asked for before Docker's
  DNAT.
- **Applying cannot lock you out.** A ruleset that does not allow SSH from
  the path Dokploy uses is refused. The server snapshots its rules, arms a
  rollback (systemd timer, or a background sleep where there is no systemd),
  applies, and Dokploy then reconnects on a **new** connection to confirm.
  No confirmation, no firewall change: it restores itself within two
  minutes.
- **Drift** is checked hourly by comparing a hash of what was applied with
  what is live.
- This host starts in `off`; switching it to enforce is your decision.

Tested on a real server in the sandbox: applying, staying reachable,
confirming, detecting drift, and the rollback firing when nobody confirms.

### Backups and restore drills
Integrations -> Backups and drills. Snapshots are **restic** repositories:
encrypted, deduplicated, checksummed, on any backend restic speaks (S3, B2,
SFTP, WebDAV, local). The repository password and the backend credentials
are vault references, never stored here.

- A database is dumped straight into restic through a pipe, so no temporary
  copy is written; the dump's exit status is checked and a snapshot from a
  failed dump is deleted rather than kept.
- Retention is daily/weekly/monthly/yearly and pruned after every run;
  snapshots can be copied to a second repository for the 3-2-1 rule.
- `restic check --read-data-subset` verifies a repository itself.
- What the database held is recorded **with** the snapshot, so a drill can
  tell a real restore from an empty one.

A **restore drill** takes the latest snapshot, starts the same image on an
internal network with no published ports, restores into it, checks the table
count against the backup-time numbers plus any SQL assertions you add,
measures the recovery time against a budget, and always tears the copy down.
Drills run on a schedule and a failed drill fails loudly.

Covered end to end in the sandbox against a real Postgres: backup, integrity
check, drill passing, nothing left behind, and a drill correctly failing when
the data does not match.

### Point-in-time recovery (WAL archiving)
A backup restores the database as it was when the backup ran. For Postgres,
turning on **Point-in-time** on a policy closes the gap between backups:
the write-ahead log is archived continuously, so the database can be rebuilt
as it was at any moment, and base backups can be taken far less often.

It reuses the policy's restic repository and installs nothing: no WAL-G
binary, no credentials inside the database container, and it works the same
on the Debian and the Alpine images, on amd64 and arm64.

- **Archive.** `archive_command` gzips each finished segment into a volume of
  its own (`<app>-wal`). It writes under a temporary name and renames, accepts
  a segment Postgres sends twice after a crash, and refuses to overwrite one
  with different bytes. `archive_timeout` is 60 s, which bounds what a quiet
  database can lose. The settings are written with `ALTER SYSTEM`, so they
  live in the data volume and survive redeploys; turning it on costs one
  redeploy, which also attaches the volume.
- **Ship.** Every few minutes a job snapshots that volume into the repository.
  restic deduplicates, so only new segments upload. It reads the volume and
  not the database, so it keeps working when Postgres is down, which is when
  the last segments matter most. Successful ships leave no job history;
  failures do. WAL snapshots carry their own tag, so base-backup retention
  never sees them.
- **Base backups.** WAL replays onto a physical copy, never onto a dump, so a
  policy with archiving on takes `pg_basebackup` on its schedule instead.
- **Health.** The signal is the queue of segments waiting to be archived and
  the archiver's failure count, not the time since the last segment: an idle
  database writes no WAL, and silence is normal. A problem raises
  `wal.lagging` once per incident.
- **Local pruning.** Segments older than the newest base backup are removed
  from the volume, but only after a ship has run two minutes past that base.
  That ordering guarantees a snapshot holding both the old segments and the
  new base exists, so every moment stays recoverable. Timeline history files
  are never pruned.
- **Recover.** Pick a moment, or none for the latest. The base backup before
  it goes into a fresh volume, the WAL is checked for holes, replayed in a
  container on an internal network with no ports, promoted and queried. By
  default that is a verified copy and the live database is never touched.
  **Replace the live database** swaps the copy in: it needs approval, the old
  data is kept in its own volume, and a new base backup follows because the
  database continues on a new timeline.
- **Drills** for such a policy are a real point-in-time recovery.

Turning it off sets `archive_command` to `/bin/true` first: `archive_mode`
only changes at a restart, and until then an empty command would make
Postgres keep every segment forever.

Covered in the sandbox against a real Postgres: recovery to a moment between
two writes returning exactly the rows before it, recovery with the database
stopped, targets that cannot be reached leaving nothing behind, the swap and
archiving continuing on timeline 2, pruning, and drills passing and failing.

### AI agents: tools and events
The MCP endpoint (`/api/mcp`, JSON-RPC over one POST) now exposes write
tools alongside the read-only ones, each with MCP annotations so a client
can warn before a destructive call: deploy, set environment variables,
create and list secrets (names only), list and follow jobs, run commands on
servers, plan and apply the firewall, mesh status, backup health, run a
backup or a restore drill, and run a playbook. Every tool goes through the
same tRPC caller as the dashboard, so an agent has exactly its key's
permissions, never sees a credential, and a destructive call comes back as
`approval_required` with an id to poll through `wait_for_approval`.

**Webhooks** (Settings -> Organization -> Agents) push events instead of
making an agent poll: `job.succeeded`, `job.failed`, `backup.failed`,
`drill.failed`, `approval.requested`, `server.offline`, `firewall.drift`.
Each delivery is signed with HMAC-SHA256 in `x-dokploy-signature` and
retried by the job engine; the signing secret can be a vault reference.

### More databases and services
Settings -> Integrations -> Databases and services. Thirteen engines beyond
upstream's six — Valkey, KeyDB, Dragonfly, ClickHouse, OpenSearch,
Meilisearch, Typesense, Qdrant, RabbitMQ, NATS, Kafka, Garage and a MongoDB
replica set — each defined once (`services/abhash/engines/catalog.ts`) and
rendered into a normal Compose stack, so deploys, logs, domains, volumes and
permissions work exactly as they do for anything else. Passwords are
generated, kept in the stack's env file rather than the compose file, and
copied into the vault when it is on. Nothing is published to the host unless
you ask for it.

**Database tools** on the same page manage what Dokploy already runs:
databases, users (read-only or full, per database, password shown once) and
Postgres extensions, with identifiers strictly validated before they reach
SQL. Postgres flavour presets cover pgvector, PostGIS and TimescaleDB.

Also fixed while here: default images that do not exist (`mongo:15`,
`mariadb:4`), libsql backups named `.sql.gz` when they are a gzipped tar
(and therefore never pruned), and two concurrent Mongo restores sharing one
temporary directory.

### Upstream files the fork hooks into
Kept to one-line hooks or import swaps; expect these in merge conflicts:
`packages/server/src/lib/auth.ts` (guard hooks, SSO/SCIM plugin options,
groups plugin, banned checks, trusted SSO origins),
`packages/server/src/services/permission.ts` (rbac.v2 guards),
`packages/server/src/services/{server,git-provider}.ts` and
`apps/dokploy/server/api/routers/{server,git-provider,user,organization,
application,docker,settings}.ts` (entitlements, access and app-name checks),
`apps/dokploy/server/api/trpc.ts` (withPermission carries the route's
permission), `apps/dokploy/server/api/root.ts`, `packages/server/src/index.ts`,
`packages/server/src/db/schema/index.ts`, `apps/dokploy/pages/index.tsx` and
`register.tsx` (sign-in buttons), `apps/dokploy/lib/auth-client.ts`,
`components/dashboard/application/domains/handle-domain.tsx` (Protect with
SSO), `components/layouts/{side,user-nav}.tsx`, `esbuild.config.ts`,
`apps/dokploy/server/server.ts` (starts the job engine and the vault),
`apps/dokploy/server/api/trpc.ts` (actor in the context, key policy and
redaction), `apps/dokploy/server/api/utils/audit.ts` (records the actor),
`apps/dokploy/pages/api/mcp.ts` (actor for MCP calls),
`packages/server/src/lib/auth.ts` (exposes which API key authenticated),
`packages/server/src/utils/vault/index.ts` (resolves `${{secret.*}}` first),
`packages/server/src/utils/process/execAsync.ts` (pooled SSH),
and the schema files whose credential columns now use `credentialText`
(`ssh-key`, `destination`, `registry`, `github`, `gitlab`, `gitea`,
`bitbucket`, `ai`, `cloudflare-tunnel`, `certificate`, `web-server-settings`,
`security`, the database types, `notification`, `vault-provider`).

### What an upgrade switches on
Nothing runs by itself after an upgrade, but not everything is behind a
switch, so to be exact:

- **Behind a flag, off by default** (`abhash_settings`): RBAC v2, SSO, SCIM,
  the job engine, the vault, pooled SSH, credential encryption.
- **Gated by the job engine.** Fleet commands, Ansible, firewall applies,
  backups, drills and recovery all run as jobs, so with the engine off they
  can be configured but never execute.
- **Admin-only and inert until used.** The mesh, firewall rules, backup
  policies and managed services have no switch of their own. They do nothing
  until an admin creates one. They are self-hosted features and are not
  meant for Dokploy Cloud.

Every id a client sends (server, database, repository, API key) is checked
against the caller's organization on the server, not in the menu.

### Migrations
Fork migrations run automatically on startup and are idempotent, so a
database that already applied one under an earlier number re-applies it as a
no-op: `0197`-`0199` (auth methods, log drains, Cloudflare tunnels),
`0200`-`0201` (teams, role bindings, suspension, cleanup triggers), `0202`
(SSO provider settings and group mappings), `0203` (forward-auth gates),
`0204` (job history), `0205` (vault secrets, versions and usage), `0206`
(agents, key policies and approvals), `0207` (Ansible projects and runs), `0208` (server groups and
server metadata), `0209` (mesh providers and server peers), `0210` (firewall policies, rules
and per-server state), `0211` (backup repositories, policies, runs and
drills), `0212` (event webhooks), `0213` (managed services), `0214` (WAL
archiving on backup policies), `0215` (switches off firewall rules whose
source was stored unreadably), `0216` (drills that compare against the live
database), `0217` (the crash-loop notification event, on for channels that
already alert on build errors).
