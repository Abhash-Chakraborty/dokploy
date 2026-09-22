# Fork backlog

Raised 2026-09-20. Items marked **verified** have a confirmed root cause in this
repo or in the production database; the rest still need investigation.

## Done on `fix/sso-linking-and-ansible-key`

- SSO account linking (1.1) and the Ansible key format (1.2). The two failed
  Command centre jobs, `fleet.bootstrap` and `fleet.patch`, were both the key
  bug; their logs carry the same libcrypto error.
- The credential form flashing on reload (1.3).
- Routine jobs no longer keep a row and a log file per run, and fact collection
  moved from every five minutes to every fifteen.
- Activity sheet spacing, with self-test on the title row.
- Terminal no longer clips its bottom rows.
- "My account" is no longer shouted.
- Invitations explain the missing email provider instead of showing an empty
  select, and preselect the only one when there is exactly one.
- Every settings page carries a hover description, so 2.3 and 2.4 are legible
  without opening both pages. The merges themselves are still open.
- Every audit action has a translucent badge; `create`, `login` and `logout`
  were falling through to grey.
- Command centre keeps the settings nav open (2.5).
- The card-in-a-card box is gone from all twenty-three pages that had it.
- The builds page swapped its permanent yellow block for a hover note.
- Secure network can scan the servers and report the mesh they are already on
  (5.1, detection half).

### Second batch

- Secrets and Backups are each one page with two tabs now (2.1, 2.4). The old
  URLs redirect to the matching tab, and each tab carries the permission gate
  its old nav entry had.
- Adding a repository can start from an S3 destination (2.2).
- Setup Server reads as "Re-run setup" once Docker and Swarm are up (2.6).
- **Capacity figures are correct** (part of 2.7). `getconf _NPROCESSORS_ONLN`
  matches `nproc` and `lscpu`, and the memory percentage matches `free`. The
  stored facts read 2 vCPU and 954 MB, which is what an Oracle free-tier micro
  instance actually is: one OCPU is two vCPUs, and 954 MB is a gigabyte less
  what the kernel reserves. Nothing to fix here.

### Third batch

- Drills can compare a restore against the live database, not only against the
  numbers recorded when the backup was taken (new; this was the gap behind
  "test if the backup works"). WAL shipping and point-in-time recovery already
  existed and were not the missing piece.
- Service cards on the project page no longer overlap each other; the status
  and select controls used to hang outside the card on negative offsets.
- Fleet drift warnings for Docker, Traefik and swarm state now link into
  Command centre, which is where patching and baselines are run (2.7).
- Baseline repairs a half-configured package state before installing.

### Fourth batch (v0.30.9)

- **The firewall had never been applied on any server.** Every apply failed
  with "iptables-save: Permission denied" because the scripts ran as the
  `ubuntu` SSH user, and every failure was reported as a success. Apply,
  confirm and the drift inspection now run as root through passwordless sudo,
  and a run where any server fails is a failed run. The hourly "all four
  servers drifted" reports were the same bug: `ufw status` refused without root.
- Members and roles: nothing was disabled. Role-based access v2 is on; there is
  one member (the owner), no custom roles and no pending invitations.
- SCIM is enabled with no connection yet. Setup is explained in the session
  notes: base URL `https://dokploy.abhashchakraborty.tech/api/auth/scim/v2`,
  token from Authentication, Provisioning.

### Fifth batch

- **Crash-loop alerts.** A job every two minutes probes every server (the
  Dokploy host locally, remote servers over the pooled SSH connection) and
  reports compose/plain containers whose restart count climbs by three inside
  fifteen minutes, and swarm services with three `failed`/`rejected` tasks in
  the same window (a deploy's `shutdown` tasks never count). One alert per
  service per hour, named after the Dokploy service with a link to it. New
  notification event "Container Crash Loop" (migration `0217`), switched on for
  every channel that already alerted on build errors.
- **Server cron.** Schedules, Server cron lists every user crontab,
  `/etc/crontab`, `/etc/cron.d`, the `cron.*` directories and systemd timers on
  a server, read-only. Jobs added from Dokploy go to `/etc/cron.d/dokploy`
  behind id markers, written atomically, and only those can be removed.
- **Replicas across nodes.** Cluster settings gain "Spread across nodes" and
  "Max per node" (placement preference `spread=node.id`, `MaxReplicas`);
  compose stacks get the same on the Containers tab.
- **The assistant is agentic.** It looks things up with the MCP tool registry
  through the user's own tRPC caller, and in Write/Debug mode turns changes
  into proposals the user runs from the panel (`ai.runAction`, audited).
- UI: one-line logs toolbar with an icon pill, quiet alerts, circle-i hints
  (triangle for warnings) instead of banners, tabs and server picker on one
  line (Docker, Schedules, Traefik), wider breadcrumbs, compact service cards,
  new update dialog, sign-in page branding, regrouped navigation.

### Sixth batch

- **Middlewares from the dashboard.** Settings → Middlewares defines rate
  limits, IP allowlists, password gates, headers, redirects and custom Traefik
  middlewares. Each applies to domains where it is picked, to every project,
  or to chosen projects; the owner can also put one in front of the Dokploy
  dashboard. Definitions go to one file per organization on every server
  (migration `0218`); application routers update at once, compose routers on
  their next deploy. Deleted or disabled ones stay defined as a no-op so no
  router ever names a missing middleware, and nothing written can contain an
  empty section, since one refused file stops Traefik reloading every file on
  that server.
- **Databases and services work.** Stacks deployed to a sandbox daemon now
  stay there (`env -i` dropped `DOCKER_HOST`), every engine joins
  `dokploy-network` under the address it advertises, and NATS, Garage,
  Meilisearch, Kafka, MongoDB and KeyDB (ARM) start. The Mongo replica set
  initiates itself. Every engine is deployed and checked by
  `scripts/sandbox/e2e/engines.mjs`. The page explains what each is for.
- **Command centre playbooks.** Baseline refreshes the apt cache, updates
  repair a half-configured dpkg and give sshd its `/run/sshd`, cleanup gathers
  the facts it reads, and the sshd handler no longer fails on socket-activated
  24.04.
- Assistant replies render as Markdown (HTML answers are converted, never
  injected). Log drains say what they send.

### Still open

- **Stream assistant replies.** `ai.chat` waits for the whole agent loop
  (`generateText` with tools) before returning, so long answers appear at
  once after a pause. Move it to `streamText` over an SSE route (tRPC
  subscriptions are not wired here) and stream text deltas plus tool-call
  events into the panel.

- **Firewall adoption** (importing hand-written ufw rules into a Dokploy
  policy). Deferred on purpose: applying now works, keeps hand-written rules,
  and rolls back within two minutes if it cuts SSH, so adoption is a nicety
  rather than a blocker. Preview, then apply one server first.
- `fleet.ssh` is the one fork flag still off. It routes every remote deploy
  through the pooled SSH layer (connection reuse, pinned host keys). Faster
  deploys, but it changes the deploy path, so it is a deliberate switch.
- Run baseline against `abhash-amd` after `dpkg --configure -a` on that host.

## 1. Bugs that block something today

### 1.1 SSO account linking never works — **verified**
Signing in with Authentik against an existing account fails with
`account not linked`, even with "Link existing accounts by email" switched on.

The Better Auth SSO plugin declares `domainVerified` as a database field **only**
when it is constructed with domain verification enabled. `packages/server/src/lib/auth.ts:500`
constructs it without that option, so the adapter drops the column when it reads
the provider row, the callback's `"domainVerified" in provider` test is false, and
`isTrustedProvider` is permanently false. The admin toggle writes a column nothing
reads back.

Fix: inject the field into the plugin's schema after constructing `sso()`, so the
adapter returns it. Do **not** enable the plugin's own `domainVerification`: that
also blocks sign-in outright for any provider with the switch off and adds a DNS
TXT challenge, which is not what the UI promises.

Also dead on the SSO path, worth cleaning up while in here:
- `account.accountLinking.trustedProviders` in the same file. The SSO plugin passes
  `trustProviderByName: false`, which bypasses that list entirely.
- `getTrustedProviders` in `packages/server/src/services/admin.ts:163` is a stub
  returning an empty array.

### 1.2 Ansible baseline cannot authenticate — **verified in code, key bytes unconfirmed**
`baseline.yml` fails at Gathering Facts:
`Load key "keys/abhash-amd": error in libcrypto` / `Permission denied (publickey)`.

The host-key scan immediately before it succeeds, and that uses the same key
through Node's `ssh2`. So the key itself is good; what is written to disk is not.
`writeWorkDir` at `packages/server/src/services/abhash/ansible/runner.ts:98` writes
`host.privateKey` verbatim. The `known_hosts` write ten lines below explicitly
appends `\n`; the key write does not. Nothing anywhere in the repo normalises a
private key's trailing newline or strips CR. `ssh2` is lenient about this, OpenSSH
is not, and "error in libcrypto" is the classic OpenSSH symptom.

Fix: normalise on write (ensure exactly one trailing `\n`, strip `\r`). Normalise on
save too, in the SSH key service, so existing rows get repaired.

Not yet confirmed: the exact decrypted bytes. `privateKey` is a `credentialText`
column, encrypted at rest, and I did not decrypt it to check.

### 1.3 Email/password form flashes on load when disabled
On `apps/dokploy/pages/index.tsx` the auth-method query starts undefined and
`methodEnabled` deliberately defaults to enabled while loading, so the credential
form paints for one frame before disappearing. Render the form only once the query
has resolved, or server-side the auth methods into props.

### 1.4 Two failed fleet jobs
`abhash_job` holds one failed `fleet.bootstrap` and one failed `fleet.patch`.
Read the stored logs and work out whether they share the 1.2 cause.

## 2. Consolidation and information architecture

### 2.1 Merge the two backup surfaces
There are two, not three: **Backups and drills** (`backup-health`, the fork's restic
engine) and **Backups (legacy)** (`backups`, upstream's per-service S3 dumps).
"Backup drill" is a feature inside the first, not a separate page. Merge into one
page with the legacy list as a section, and a migration path off it.

### 2.2 Backups ask for a repository even though an S3 destination exists — **verified**
These are different objects. An S3 **destination** is upstream's bucket credential,
used by legacy backups. A **repository** is a restic repository: an encrypted,
deduplicated store with its own password, described in
`packages/server/src/db/schema/abhash-backups.ts:33`. The repository string can point
at the same bucket, but restic has to own and initialise that prefix.

Production currently has one destination (Cloudflare R2) and zero repositories, which
is exactly why the page asks. Fix by offering "create a repository from an existing S3
destination", prefilling the endpoint and credentials.

### 2.3 AI vs Agents
Not a duplicate, and they are already in different groups. **AI** (Integrations) is the
LLM provider and API key used by the assistant. **Agents** (Organization) are service
accounts with scoped API keys for machine access, and never see secret values. Rename
so this reads off the label, e.g. "AI provider" and "Service accounts".

### 2.4 Vault vs Secret providers
Also not a duplicate, both already under Sources & Secrets. **Vault** is the built-in
encrypted store; secrets are referenced as `${{secret.NAME}}`. **Secret providers**
connect an external manager (Infisical and friends) so the same reference syntax
resolves from there. Merge into one page with two tabs, local and external.

### 2.5 Command centre has no home
`/dashboard/command-center` is a top-level page but is listed under the Organization
settings group in `apps/dokploy/components/layouts/side.tsx:333`. The layout only
renders the settings sub-nav for `/dashboard/settings/*`, so the page loads with the
Home chrome. Either move the route under settings or give it a first-class nav entry.

### 2.6 "Setup Server" shown after a server is already set up
Drive the prompt off collected facts rather than a static flag, and route the action
through Command centre.

### 2.7 Fleet warnings should link to Command centre actions
Traefik version drift, Swarm role and inactive state, and capacity all surface as
warnings with no action attached. Link each to the Command centre operation that
fixes it: update Docker, update Traefik, promote or demote a Swarm manager. Also
check the vCPU and capacity figures, which look wrong.

## 3. Remove the boxy look, go edge-to-edge

Same treatment everywhere; these pages still wrap content in a `Card`:
- Log drains, `components/dashboard/settings/log-drains/show-log-drains.tsx:403`
- DNS providers, `components/dashboard/settings/dns/show-dns-providers.tsx:43`
- Certificates and Cloudflare tunnels, `components/dashboard/settings/tunnels/show-cloudflare-tunnels.tsx:212`
- Server overview
- Backups
- Remote servers in Fleet

Then sweep the app for the same pattern so this stops coming back. The fork's own
pages already use `PageHeader` + `PageContainer`; make that the only pattern.

## 4. UI polish

- **AI Assistant sidebar**: padding and spacing are off, and it should be able to
  drive everything the dashboard can.
- **Audit log badges**: make them semi-transparent with light fills, as upstream has.
- **"My Account" in all caps**: `components/layouts/user-nav.tsx:74`. `DropdownMenuLabel`
  applies `uppercase`; the email below it already works around this with `normal-case`.
  Add the same to the label.
- **Terminal cut off**: the infrastructure terminal loses a few lines at the bottom.
  Fix the height calculation and the alignment.
- **Build page concurrency warning**: replace the yellow bar with an inline eye icon
  that reveals the detail on hover. Apply the same treatment to the other inline errors.
- **Self-help**: use a heart icon.
- **Analytics**: verify the whole page works, self-help included.

## 5. Detect what is already there

### 5.1 NetBird is already running but Dokploy does not know
All four servers are registered on `100.97.x.x`, which is mesh addressing, yet
`abhash_mesh_provider` has zero rows. The Secure network page should detect an
existing mesh from the interface and the server addresses and offer to adopt it,
rather than starting from empty.

### 5.2 Firewall
`abhash_firewall_policy` has zero rows and `abhash_server_firewall` has one. Import
the rules already on the hosts into a policy, then offer enforcement and drift
detection. A `firewall.check-drift` job has already run once successfully, so the
drift half exists.

### 5.3 Baseline
Document exactly what `baseline.yml` changes before it is run again, and test it
against a sandbox host, not production. Blocked on 1.2.

## 6. Access, and things to write up

- **Members, roles, teams**: enable the full set properly.
- **Invitations**: no SMTP is configured anywhere. No `SMTP_*` env vars on the running
  container, and the `email` notification table is empty; only Discord and Telegram
  are set up. The invitation link flow works without SMTP. Decide which you want.
- **SCIM**: `scim_provider` has zero rows. Write up what it does and how to point
  Authentik at it.
- **Remote server**: deferred by request.

## 7. Planned: larger features

Answers and designs from the 2026-09-22 review. Each is its own PR.

### 7.1 Scaling, load balancing and autoscaling
Today: a service's replicas run on the nodes of one swarm (the Dokploy host's,
or one remote server's) and the swarm routing mesh balances across them; add
nodes under Docker, Swarm, Nodes, and turn on "Spread across nodes". Separate
remote servers are separate swarms, so one service does not span them.
Autoscaling does not exist in Swarm. Plan: an `autoscale` job reading the
monitoring agent's per-service CPU/memory, scaling between a min and max with
a cooldown, configured per service next to Replicas.

### 7.2 When the Dokploy server fails
Running services keep running: containers, Traefik and swarm tasks live on the
servers, not in Dokploy. What stops is the control plane (deploys, webhooks,
schedules, backups, alerts) and anything hosted on the Dokploy host itself.
Plan: back up the Dokploy database on a schedule with the restic engine and
drill the restore; then a documented standby (second manager, restore, point
DNS), and alert on the Dokploy host from another server.

### 7.3 Framework auto-detection without a Dockerfile
Railpack (and Nixpacks) already detect Next.js, Vite, Angular, Express and
friends and build without a Dockerfile; the result still runs as a container,
which is what Dokploy schedules. Missing is the Vercel feel: on the source step,
read `package.json`/lockfiles through the git provider, show "Detected Next.js
(pnpm)", prefill build/start commands and port, and default new apps to
Railpack.

### 7.4 Unmanaged containers and zero-downtime adoption
The crash-loop probe already lists every container per server. Next: an
"Unmanaged" view in Inventory (containers matching no Dokploy appName), then
"Adopt": generate a compose service from `docker inspect` (image, env, mounts,
ports, labels), start it next to the old one, move the Traefik route, stop the
old container. Volumes are reused in place, so no copy.

### 7.5 Blue/green and adding services without downtime
Swarm settings already allow `start-first` updates with a health check: the new
task must be healthy before the old one stops. That is the zero-downtime path
for applications; blue/green as an explicit toggle (two services, route switch)
is a follow-up. Adding Redis, a queue or another service never touches running
ones; wiring it in is an env change plus a start-first redeploy.

### 7.6 Arcane parity
Already here: containers, images, volumes, networks, events, disk usage,
compose stacks, templates, terminals, logs, remote hosts, image scans. Gaps:
image update checks (compare running digests with the registry, notify),
opt-in auto-update per service, a volume file browser, per-container live stats
in the table, and bulk container actions.

### 7.7 Logs to Grafana
Supported: Settings, Integrations, Log drains, type Loki. Point it at Grafana
Cloud Loki with basic auth, or at a self-hosted Loki, per server.

### 7.8 Service accounts (agents) and the API
Same API as everyone: an agent's API key authenticates the same tRPC endpoints
and `/api/mcp`, through the same RBAC as a person. The key policy can narrow it
further (read-only, allow list, IP allow list) and route destructive jobs
through human approval.
