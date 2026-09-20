# Fork backlog

Raised 2026-09-20. Items marked **verified** have a confirmed root cause in this
repo or in the production database; the rest still need investigation.

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
