// Host crontabs end to end over real SSH: list everything cron runs on a
// fleet host, add a job through the API, see it land in /etc/cron.d/dokploy,
// and remove it again without touching hand-written crontabs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runChecks, signInOwner, trpc } from "./lib.mjs";

const [host] = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean)
	.map((entry) => {
		const [name, address] = entry.split("=");
		return { name, address };
	});
const keyPath = process.env.SANDBOX_FLEET_KEY;
assert.ok(host && keyPath, "start the sandbox with --fleet");
assert.ok(host.name.startsWith("dkp-sbx-"), "not a sandbox fleet host");

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input) => trpc(procedure, input, owner, "query");
// Over SSH with the sandbox fleet key, like Dokploy itself: the script runs
// with DOCKER_HOST aimed at the sandbox daemon, which does not hold the fleet.
const onHost = (...cmd) =>
	execFileSync(
		"ssh",
		[
			"-i",
			keyPath,
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"LogLevel=ERROR",
			`root@${host.address}`,
			cmd.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" "),
		],
		{ encoding: "utf8" },
	);

// A hand-written crontab that must survive every change made from Dokploy.
onHost(
	"sh",
	"-c",
	'printf "MAILTO=\\"\\"\\n*/10 * * * * /usr/local/bin/backup.sh --quick >/dev/null 2>&1\\n" | crontab -',
);
onHost("rm", "-f", "/etc/cron.d/dokploy");

const key = await trpc(
	"sshKey.create",
	{
		name: `cron-${suffix}`,
		description: "sandbox fleet",
		privateKey: readFileSync(keyPath, "utf8"),
		publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
		organizationId: "",
	},
	owner,
);
assert.ok(key.ok, key.error);
const sshKeyId = (await q("sshKey.all")).data.find(
	(row) => row.name === `cron-${suffix}`,
).sshKeyId;
const server = await trpc(
	"server.create",
	{
		name: `cron-${suffix}`,
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
const serverId = server.data.serverId;
// First contact pins the host key; the fleet e2e does the same.
await trpc("fleet.acceptHostKey", { serverId }, owner);

let managedId;

await check("lists user crontabs, cron.d, periodic scripts", async () => {
	const list = await q("fleet.cron.list", { serverId });
	assert.ok(list.ok, list.error);
	const backup = list.data.find((e) =>
		e.command.startsWith("/usr/local/bin/backup.sh"),
	);
	assert.ok(backup, "the hand-written crontab is listed");
	assert.equal(backup.schedule, "*/10 * * * *");
	assert.equal(backup.user, "root");
	assert.equal(backup.managed, false);
	assert.ok(list.data.some((e) => e.origin === "/etc/cron.d/e2scrub_all"));
	assert.ok(list.data.some((e) => e.source === "periodic"));
});

await check("rejects a job that could break out of its line", async () => {
	const bad = await trpc(
		"fleet.cron.add",
		{
			serverId,
			name: "x",
			schedule: "* * * * *",
			user: "root",
			command: "ls\n* * * * * root touch /tmp/pwned",
		},
		owner,
	);
	assert.equal(bad.ok, false);
	assert.match(bad.error, /single line/);
});

await check("adds a job to /etc/cron.d/dokploy", async () => {
	const added = await trpc(
		"fleet.cron.add",
		{
			serverId,
			name: "Nightly prune '$(id)'",
			schedule: "0 3 * * *",
			user: "root",
			command: "docker system prune -f >/dev/null 2>&1",
		},
		owner,
	);
	assert.ok(added.ok, added.error);
	managedId = added.data.managedId;
	const file = onHost("cat", "/etc/cron.d/dokploy");
	assert.match(file, /^0 3 \* \* \* root docker system prune -f/m);
	assert.match(file, new RegExp(`# dokploy-id: ${managedId} Nightly prune`));
	assert.equal(onHost("stat", "-c", "%a", "/etc/cron.d/dokploy").trim(), "644");
	assert.ok(!onHost("ls", "/tmp").includes("pwned"));
	const list = await q("fleet.cron.list", { serverId });
	const mine = list.data.find((e) => e.managedId === managedId);
	assert.equal(mine?.managed, true);
	assert.equal(mine?.name, "Nightly prune '$(id)'");
});

await check("removes only Dokploy's job", async () => {
	const second = await trpc(
		"fleet.cron.add",
		{
			serverId,
			name: "keep",
			schedule: "@hourly",
			user: "root",
			command: "true",
		},
		owner,
	);
	assert.ok(second.ok, second.error);
	const removed = await trpc(
		"fleet.cron.remove",
		{ serverId, managedId },
		owner,
	);
	assert.ok(removed.ok, removed.error);
	const list = await q("fleet.cron.list", { serverId });
	assert.equal(
		list.data.some((e) => e.managedId === managedId),
		false,
	);
	assert.ok(list.data.some((e) => e.managedId === second.data.managedId));
	assert.match(onHost("crontab", "-l"), /backup\.sh --quick/);
});

await check("refuses to remove a job Dokploy did not write", async () => {
	const other = await trpc(
		"fleet.cron.remove",
		{ serverId, managedId: "notmine" },
		owner,
	);
	assert.equal(other.ok, false);
});

await trpc("server.remove", { serverId }, owner);
onHost("rm", "-f", "/etc/cron.d/dokploy");

await finish();
