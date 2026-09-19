// The command centre against the sandbox fleet: inventory, health, host-key
// pinning and a bulk command, all over the API.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const fleet = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean)
	.map((entry) => {
		const [name, address] = entry.split("=");
		return { name, address };
	});
const keyPath = process.env.SANDBOX_FLEET_KEY;
assert.ok(fleet.length && keyPath, "start the sandbox with --fleet");

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input) => trpc(procedure, input, owner, "query");

const waitJob = async (id, ms = 120_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const result = await q("abhashJobs.get", { id });
		if (
			result.ok &&
			["succeeded", "failed", "cancelled"].includes(result.data.status)
		) {
			return result.data;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("job never finished");
};

await trpc("abhashJobs.setEnabled", { enabled: true }, owner);

const created = await trpc(
	"sshKey.create",
	{
		name: `fleet-${suffix}`,
		description: "sandbox fleet",
		privateKey: readFileSync(keyPath, "utf8"),
		publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
		organizationId: "",
	},
	owner,
);
assert.ok(created.ok, created.error);
const keys = await q("sshKey.all");
const sshKeyId = keys.data.find(
	(key) => key.name === `fleet-${suffix}`,
).sshKeyId;

const serverIds = [];
for (const host of fleet) {
	const server = await trpc(
		"server.create",
		{
			name: `${host.name}-${suffix}`,
			description: "sandbox fleet",
			ipAddress: host.address,
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
		},
		owner,
	);
	assert.ok(server.ok, server.error);
	serverIds.push(server.data.serverId);
}

await check("the fleet lists every server with its metadata", async () => {
	const list = await q("fleet.list");
	assert.ok(list.ok, list.error);
	const mine = list.data.servers.filter((s) => serverIds.includes(s.serverId));
	assert.equal(mine.length, fleet.length);
});

await check(
	"refreshing a server reads its facts and pins the host key",
	async () => {
		const refreshed = await trpc(
			"fleet.refresh",
			{ serverId: serverIds[0] },
			owner,
		);
		assert.ok(refreshed.ok, refreshed.error);
		assert.equal(refreshed.data.health, "online");
		assert.match(refreshed.data.facts.os, /Ubuntu/);
		const [row] =
			await sql`select host_key from abhash_server_meta where server_id = ${serverIds[0]}`;
		assert.match(row.host_key, /^SHA256:/);
	},
);

await check(
	"a changed host key blocks the server until it is accepted",
	async () => {
		await sql`update abhash_server_meta set host_key = 'SHA256:wrong' where server_id = ${serverIds[0]}`;
		// Force a fresh handshake: the pool keeps the verified connection open.
		await trpc(
			"fleet.setMeta",
			{ serverId: serverIds[0], connectVia: "public" },
			owner,
		);
		const refreshed = await trpc(
			"fleet.refresh",
			{ serverId: serverIds[0] },
			owner,
		);
		assert.equal(refreshed.data.health, "offline");
		assert.match(refreshed.data.error, /host key changed/i);
		const accepted = await trpc(
			"fleet.acceptHostKey",
			{ serverId: serverIds[0] },
			owner,
		);
		assert.ok(accepted.ok, accepted.error);
		const again = await trpc(
			"fleet.refresh",
			{ serverId: serverIds[0] },
			owner,
		);
		assert.equal(again.data.health, "online");
	},
);

await check(
	"a command runs across the fleet and reports each server",
	async () => {
		const started = await trpc(
			"fleet.run",
			{
				action: "exec",
				serverIds,
				command: "hostname; echo done",
				mode: "parallel",
				batchSize: 5,
				stopOnFailure: false,
			},
			owner,
		);
		assert.ok(started.ok, started.error);
		assert.ok(started.data.jobId, "a person's command runs without approval");
		const job = await waitJob(started.data.jobId);
		assert.equal(job.status, "succeeded", job.error);
		assert.equal(job.result.failed, 0);
		assert.equal(job.result.ok, fleet.length);
		const log = await q("abhashJobs.log", {
			id: started.data.jobId,
			offset: 0,
		});
		assert.match(log.data.text, /done/);
	},
);

await check("a failing command is reported, not hidden", async () => {
	const started = await trpc(
		"fleet.run",
		{
			action: "exec",
			serverIds: [serverIds[0]],
			command: "exit 7",
			mode: "serial",
			batchSize: 1,
			stopOnFailure: true,
		},
		owner,
	);
	const job = await waitJob(started.data.jobId);
	assert.equal(job.status, "succeeded");
	assert.equal(job.result.failed, 1);
	assert.equal(job.result.outcomes[0].exitCode, 7);
});

await check("tags and maintenance stick to a server", async () => {
	const saved = await trpc(
		"fleet.setMeta",
		{
			serverId: serverIds[0],
			tags: ["web", "prod"],
			environmentLabel: "prod",
			maintenance: true,
		},
		owner,
	);
	assert.ok(saved.ok, saved.error);
	const list = await q("fleet.list");
	const row = list.data.servers.find((s) => s.serverId === serverIds[0]);
	assert.deepEqual(row.meta.tags, ["web", "prod"]);
	assert.equal(row.meta.maintenance, true);
});

for (const serverId of serverIds) {
	await trpc("server.remove", { serverId }, owner);
}
await trpc("sshKey.remove", { sshKeyId }, owner);
await trpc("abhashJobs.setEnabled", { enabled: false }, owner);
await finish();
