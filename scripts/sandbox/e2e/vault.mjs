// The vault over the API: owner switch, write-only values, scope visibility,
// reveal restricted to the owner with a password, and the recovery kit.
import assert from "node:assert/strict";
import { auth, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const q = (p, input, c = owner) => trpc(p, input, c, "query");
const suffix = Date.now().toString(36);
const NAME = `E2E_TOKEN_${suffix.toUpperCase()}`;
const SCOPED = `PROJECT_ONLY_${suffix.toUpperCase()}`;
const MEMBER_ORG = `MEMBER_ORG_${suffix.toUpperCase()}`;

await check("owner turns the vault on and gets a recovery kit", async () => {
	const on = await trpc("vault.setEnabled", { enabled: true }, owner);
	assert.ok(on.ok, on.error);
	const status = await q("vault.status");
	assert.equal(status.data.enabled, true);
	assert.equal(status.data.keyReady, true);
	const kit = await trpc(
		"vault.exportRecoveryKit",
		{ passphrase: "correct horse battery staple" },
		owner,
	);
	assert.ok(kit.ok, kit.error);
	assert.equal(kit.data.format, "dokploy-vault-recovery");
	assert.ok(!JSON.stringify(kit.data).includes("BEGIN"));
});

const project = await trpc(
	"project.create",
	{ name: `vault-${suffix}` },
	owner,
);
assert.ok(project.ok, project.error);
const projectId = project.data.project?.projectId ?? project.data.projectId;

let secretId;
await check("a secret is stored and never returned by the list", async () => {
	const created = await trpc(
		"vault.create",
		{
			name: NAME,
			description: "used by the e2e test",
			value: "s3cret-e2e-value",
			tags: [],
			expiresAt: null,
			rotateEveryDays: null,
			scopeType: "organization",
		},
		owner,
	);
	assert.ok(created.ok, created.error);
	secretId = created.data.id;
	const list = await q("vault.list");
	assert.ok(list.ok, list.error);
	const body = JSON.stringify(list.data);
	assert.ok(body.includes(NAME));
	assert.ok(!body.includes("s3cret-e2e-value"), "values must never be listed");
});

await check("the owner can reveal only with the right password", async () => {
	const wrong = await trpc(
		"vault.reveal",
		{ id: secretId, password: "not-the-password" },
		owner,
	);
	assert.equal(wrong.ok, false);
	const right = await trpc(
		"vault.reveal",
		{ id: secretId, password: "Sandbox-pass-123" },
		owner,
	);
	assert.ok(right.ok, right.error);
	assert.equal(right.data.value, "s3cret-e2e-value");
	const rows =
		await sql`select 1 from audit_log where resource_type = 'secret' and metadata like '%revealed%'`;
	assert.ok(rows.length > 0, "reveal must be audited");
});

await check("a member cannot reveal and cannot see other scopes", async () => {
	const email = `vault-member-${suffix}@sandbox.test`;
	const password = "Sandbox-pass-123";
	const created = await trpc(
		"user.createUserWithCredentials",
		{ email, password, role: "member" },
		owner,
	);
	assert.ok(created.ok, created.error);
	const login = await auth("/sign-in/email", { email, password });
	assert.equal(login.status, 200, login.text);
	const member = login.cookie;

	const scoped = await trpc(
		"vault.create",
		{
			name: SCOPED,
			description: "",
			value: "project-scoped",
			tags: [],
			expiresAt: null,
			rotateEveryDays: null,
			scopeType: "project",
			scopeId: projectId,
		},
		owner,
	);
	assert.ok(scoped.ok, scoped.error);

	const list = await q("vault.list", undefined, member);
	assert.ok(list.ok, list.error);
	const names = list.data.map((s) => s.name);
	assert.ok(names.includes(NAME), "organization secrets are visible");
	assert.ok(!names.includes(SCOPED), "a project they cannot open stays hidden");

	const reveal = await trpc("vault.reveal", { id: secretId, password }, member);
	assert.equal(reveal.ok, false);
	const orgWide = await trpc(
		"vault.create",
		{
			name: MEMBER_ORG,
			description: "",
			value: "x",
			tags: [],
			expiresAt: null,
			rotateEveryDays: null,
			scopeType: "organization",
		},
		member,
	);
	assert.equal(orgWide.ok, false, "members cannot add organization secrets");
});

await check("a new value becomes the current version", async () => {
	const set = await trpc(
		"vault.setValue",
		{ id: secretId, value: "rotated-value" },
		owner,
	);
	assert.ok(set.ok, set.error);
	assert.equal(set.data.version, 2);
	const revealed = await trpc(
		"vault.reveal",
		{ id: secretId, password: "Sandbox-pass-123" },
		owner,
	);
	assert.equal(revealed.data.value, "rotated-value");
	const versions = await q("vault.versions", { id: secretId });
	assert.equal(versions.data.versions.length, 2);
});

await check("rotating the master key keeps values readable", async () => {
	const rotated = await trpc("vault.rotateKey", null, owner);
	assert.ok(rotated.ok, rotated.error);
	const revealed = await trpc(
		"vault.reveal",
		{ id: secretId, password: "Sandbox-pass-123" },
		owner,
	);
	assert.equal(revealed.data.value, "rotated-value");
});

await check("the vault can be turned off again", async () => {
	const off = await trpc("vault.setEnabled", { enabled: false }, owner);
	assert.ok(off.ok, off.error);
});

await finish();
