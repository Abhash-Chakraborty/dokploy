// WAL archiving over the API: what it accepts, what it refuses, that an in
// place recovery by an agent waits for a person, and that deleting a policy
// takes its schedules with it. The recovery itself is proven against a real
// database in __test__/integration/pitr.test.ts.
import assert from "node:assert/strict";
import { base, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input, cookie = owner) =>
	trpc(procedure, input, cookie, "query");

const [{ organization_id: organizationId }] =
	await sql`select organization_id from member where role = 'owner' limit 1`;

const repository = await trpc(
	"abhashBackups.saveRepository",
	{
		name: `wal-${suffix}`,
		repository: `/var/backups/wal-e2e-${suffix}`,
		passwordRef: "wal-e2e-password",
		env: {},
	},
	owner,
);
assert.ok(repository.ok, repository.error);

const policyInput = (overrides) => ({
	name: `wal-${suffix}`,
	serverId: null,
	targetKind: "postgres",
	target: `pg-wal-${suffix}`,
	repositoryId: repository.data.id,
	...overrides,
});

let policyId;
await check("a policy takes the WAL settings, within limits", async () => {
	const tooOften = await trpc(
		"abhashBackups.savePolicy",
		policyInput({ walShipMinutes: 0 }),
		owner,
	);
	assert.equal(tooOften.ok, false);
	const saved = await trpc(
		"abhashBackups.savePolicy",
		policyInput({ walShipMinutes: 2, walRetentionDays: 14 }),
		owner,
	);
	assert.ok(saved.ok, saved.error);
	policyId = saved.data.id;
	assert.equal(saved.data.walEnabled, false, "saving never turns it on");
	assert.equal(saved.data.walShipMinutes, 2);
});

await check("archiving is refused for anything but Postgres", async () => {
	const volume = await trpc(
		"abhashBackups.savePolicy",
		policyInput({
			name: `vol-${suffix}`,
			targetKind: "volume",
			target: "some-volume",
		}),
		owner,
	);
	assert.ok(volume.ok, volume.error);
	const refused = await trpc(
		"abhashBackups.setWal",
		{ policyId: volume.data.id, enabled: true },
		owner,
	);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /Postgres/);
	await trpc("abhashBackups.removePolicy", { id: volume.data.id }, owner);
});

await check("the window is empty until there is a base backup", async () => {
	const window = await q("abhashBackups.recoveryWindow", { policyId });
	assert.ok(window.ok, window.error);
	assert.equal(window.data.earliest, null);
	assert.equal(window.data.latest, null);
});

await check("a target must be a real timestamp", async () => {
	const refused = await trpc(
		"abhashBackups.recover",
		{ policyId, targetTime: "yesterday-ish", replaceService: false },
		owner,
	);
	assert.equal(refused.ok, false);
});

await check(
	"what a policy backs up cannot change while archiving is on",
	async () => {
		await sql`update abhash_backup_policy set wal_enabled = true where id = ${policyId}`;
		const moved = await trpc(
			"abhashBackups.savePolicy",
			policyInput({ id: policyId, target: "another-database" }),
			owner,
		);
		assert.equal(moved.ok, false);
		assert.match(moved.error, /Turn WAL archiving off/);
		// Everything else about it still can.
		const retuned = await trpc(
			"abhashBackups.savePolicy",
			policyInput({ id: policyId, walShipMinutes: 10 }),
			owner,
		);
		assert.ok(retuned.ok, retuned.error);
		assert.equal(retuned.data.walEnabled, true, "saving never turns it off");
	},
);

await check("an agent's in-place recovery waits for a person", async () => {
	const agent = await trpc(
		"agents.create",
		{ name: `WAL ${suffix}`, description: "e2e", role: "admin" },
		owner,
	);
	assert.ok(agent.ok, agent.error);
	const created = await trpc(
		"agents.createKey",
		{
			agentId: agent.data.id,
			name: "wal",
			expiresInDays: 1,
			policy: {
				readOnly: false,
				allow: [],
				ipAllowList: [],
				approvalMode: "destructive",
			},
		},
		owner,
	);
	assert.ok(created.ok, created.error);
	const call = async (name, args) => {
		const res = await fetch(`${base}/api/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": created.data.key,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const body = await res.json();
		return JSON.parse(body.result.content[0].text);
	};

	const inPlace = await call("recover_to_point_in_time", {
		policyId,
		replaceService: true,
	});
	assert.equal(inPlace.status, "approval_required");
	// A copy touches nothing that is live, so it just runs.
	const copy = await call("recover_to_point_in_time", { policyId });
	assert.equal(copy.status, "running");

	const health = await call("backup_health", {});
	const mine = health.find((policy) => policy.id === policyId);
	assert.ok(mine.wal, "WAL state is reported to agents");
	await trpc("agents.remove", { id: agent.data.id }, owner);
});

await check("deleting a policy takes its schedules with it", async () => {
	const removed = await trpc(
		"abhashBackups.removePolicy",
		{ id: policyId },
		owner,
	);
	assert.ok(removed.ok, removed.error);
	const overview = await q("abhashBackups.overview");
	assert.ok(!overview.data.policies.some((policy) => policy.id === policyId));
});

await sql`delete from abhash_backup_repository where organization_id = ${organizationId} and name = ${`wal-${suffix}`}`;
await finish();
