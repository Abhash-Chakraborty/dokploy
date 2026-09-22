// The command centre's playbooks for real against the sandbox fleet: set up
// (baseline without Docker), patch and cleanup must finish, the way they have
// to on a fresh Ubuntu 24.04 whose apt lists are empty.
//   PLAYBOOKS=patch  node scripts/sandbox/e2e/playbooks.mjs   (a subset)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runChecks, signInOwner, trpc } from "./lib.mjs";

const fleet = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean)
	.map((entry) => {
		const [name, address] = entry.split("=");
		return { name, address };
	});
const keyPath = process.env.SANDBOX_FLEET_KEY;
assert.ok(fleet.length >= 3 && keyPath, "start the sandbox with --fleet");

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input) => trpc(procedure, input, owner, "query");
const wanted = (process.env.PLAYBOOKS ?? "bootstrap,patch,cleanup").split(",");

const waitJob = async (id, ms = 20 * 60_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const result = await q("abhashJobs.get", { id });
		if (
			result.ok &&
			["succeeded", "failed", "cancelled"].includes(result.data.status)
		) {
			return result.data;
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	throw new Error("job never finished");
};
const tail = async (jobId) => {
	const log = await q("abhashJobs.log", { id: jobId, offset: 0 });
	return (log.data?.text ?? "").split("\n").slice(-40).join("\n");
};

await trpc("abhashJobs.setEnabled", { enabled: true }, owner);
const created = await trpc(
	"sshKey.create",
	{
		name: `playbooks-${suffix}`,
		description: "sandbox fleet",
		privateKey: readFileSync(keyPath, "utf8"),
		publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
		organizationId: "",
	},
	owner,
);
assert.ok(created.ok, created.error);
const sshKeyId = (await q("sshKey.all")).data.find(
	(key) => key.name === `playbooks-${suffix}`,
).sshKeyId;

const servers = [];
for (const host of fleet.slice(0, 3)) {
	const server = await trpc(
		"server.create",
		{
			name: `${host.name}-pb-${suffix}`,
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
	servers.push(server.data.serverId);
}

const runJob = async (input) => {
	const queued = await trpc("fleet.run", input, owner);
	assert.ok(queued.ok, queued.error);
	assert.ok(queued.data.jobId, "the job needs approval instead of running");
	const job = await waitJob(queued.data.jobId);
	assert.equal(
		job.status,
		"succeeded",
		`${job.status}: ${job.error ?? ""}\n${await tail(queued.data.jobId)}`,
	);
};

if (wanted.includes("bootstrap")) {
	await check("set up applies the baseline on a fresh server", () =>
		runJob({
			action: "bootstrap",
			serverId: servers[0],
			baseline: true,
			hardenSsh: true,
			installDocker: false,
		}),
	);
}
if (wanted.includes("patch")) {
	await check("patching finishes without a reboot", () =>
		runJob({ action: "patch", serverIds: [servers[1]], reboot: false }),
	);
}
if (wanted.includes("cleanup")) {
	await check("cleanup finishes", () =>
		runJob({ action: "cleanup", serverIds: [servers[2]] }),
	);
}

for (const serverId of servers) {
	await trpc("server.remove", { serverId }, owner);
}
await finish();
