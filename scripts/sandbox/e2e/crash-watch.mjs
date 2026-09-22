// Crash-loop alerts end to end: a restart=always container and a swarm
// service that both keep dying, the real watcher job over the sandbox daemon,
// and a custom-webhook notification that must receive exactly one alert each.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const cookie = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);

const docker = (...args) =>
	execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
assert.ok(
	process.env.DOCKER_HOST?.startsWith("tcp://127.0.0.1:"),
	"refusing to create crashing workloads outside the sandbox daemon",
);

const received = [];
const listener = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		received.push(JSON.parse(body || "{}"));
		res.end("ok");
	});
});
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${listener.address().port}/hook`;

const loopy = `loopy-${suffix}`;
const crashy = `crashy-${suffix}`;

const runWatcher = async () => {
	const queued = await trpc(
		"abhashJobs.run",
		{ type: "containers.watch-crashes", input: {} },
		cookie,
	);
	assert.ok(queued.ok, queued.error);
	const id = queued.data.id ?? queued.data.jobId;
	for (let i = 0; i < 60; i++) {
		const [row] = await sql`select status from abhash_job where id = ${id}`;
		// Quiet runs are ephemeral and delete their own row on success.
		if (!row || row.status === "succeeded") return;
		if (row.status === "failed") throw new Error("watcher job failed");
		await sleep(1_000);
	}
	throw new Error("watcher job did not finish");
};

try {
	await check("the watcher job runs with the job engine on", async () => {
		const on = await trpc("abhashJobs.setEnabled", { enabled: true }, cookie);
		assert.ok(on.ok, on.error);
		await sql`delete from abhash_settings where key = 'crashwatch.state'`;
	});

	await check("a crash-loop notification channel can be created", async () => {
		const r = await trpc(
			"notification.createCustom",
			{
				name: `crash-watch ${suffix}`,
				endpoint,
				appBuildError: false,
				databaseBackup: false,
				dokployBackup: false,
				volumeBackup: false,
				dokployRestart: false,
				appDeploy: false,
				dockerCleanup: false,
				serverThreshold: false,
				containerHealth: true,
				userLogin: false,
			},
			cookie,
		);
		assert.ok(r.ok, r.error);
	});

	docker(
		"run",
		"-d",
		"--restart=always",
		"--name",
		loopy,
		"alpine",
		"sh",
		"-c",
		"sleep 1; exit 3",
	);
	docker(
		"service",
		"create",
		"-d",
		"--name",
		crashy,
		"--restart-condition",
		"any",
		"--restart-delay",
		"2s",
		"alpine",
		"sh",
		"-c",
		"sleep 1; exit 7",
	);

	// The first scan only records restart baselines. The two-minute schedule
	// may take it before this one does, so nothing is asserted here; the
	// first-sight rule is covered by the unit tests.
	await sleep(5_000);
	await runWatcher();

	await check("both loops are reported once they build up", async () => {
		// Docker's restart backoff doubles each time, so give it room.
		await sleep(30_000);
		await runWatcher();
		const mine = () => received.filter((p) => p.service.endsWith(suffix));
		for (let i = 0; i < 20 && mine().length < 2; i++) await sleep(500);
		// Other crash loops in the sandbox are reported too; only ours count here.
		const services = mine()
			.map((p) => p.service)
			.sort();
		// Exactly once each, whichever run noticed first.
		assert.deepEqual(services, [crashy, loopy].sort());
		for (const payload of mine()) {
			assert.equal(payload.type, "container-crash-loop");
			assert.equal(payload.serverName, "Dokploy server");
			assert.ok(payload.failures >= 3, `failures ${payload.failures}`);
		}
		const swarm = mine().find((p) => p.service === crashy);
		assert.equal(swarm.exitCode, 7);
	});

	await check("a loop is not reported again inside the cooldown", async () => {
		const ours = () =>
			received.filter((p) => p.service.endsWith(suffix)).length;
		const before = ours();
		await sleep(10_000);
		await runWatcher();
		await sleep(1_000);
		assert.equal(ours(), before);
	});
} finally {
	try {
		docker("rm", "-f", loopy);
	} catch {}
	try {
		docker("service", "rm", crashy);
	} catch {}
	await sql`delete from notification where name = ${`crash-watch ${suffix}`}`;
	listener.close();
}

await finish();
