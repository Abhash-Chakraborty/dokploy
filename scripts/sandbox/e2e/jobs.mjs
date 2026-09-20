// Job engine over the API: owner-only switch, self-test job, log, cancel,
// and member visibility.
import assert from "node:assert/strict";
import { auth, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const cookie = await signInOwner();
const { check, finish } = runChecks();
const q = (p, input, c = cookie) => trpc(p, input, c, "query");

const waitStatus = async (id, statuses, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const r = await q("abhashJobs.get", { id });
		if (r.ok && statuses.includes(r.data.status)) return r.data;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`job ${id} never reached ${statuses}`);
};

await check("engine can be turned on by the owner", async () => {
	const r = await trpc("abhashJobs.setEnabled", { enabled: true }, cookie);
	assert.ok(r.ok, r.error);
	const s = await q("abhashJobs.status");
	assert.equal(s.data.enabled, true);
	assert.equal(s.data.running, true);
	assert.equal(s.data.redisReachable, true);
});

let jobId;
await check("self-test runs and streams its log", async () => {
	const r = await trpc("abhashJobs.selfTest", null, cookie);
	assert.ok(r.ok, r.error);
	jobId = r.data.id;
	const done = await waitStatus(jobId, ["succeeded", "failed"]);
	assert.equal(done.status, "succeeded");
	const log = await q("abhashJobs.log", { id: jobId, offset: 0 });
	assert.match(log.data.text, /Job engine is working \(5\/5\)/);
	const tail = await q("abhashJobs.log", {
		id: jobId,
		offset: log.data.nextOffset,
	});
	assert.equal(tail.data.text, "");
});

await check("jobs are listed with an active count", async () => {
	const r = await q("abhashJobs.list", { limit: 10 });
	assert.ok(r.ok, r.error);
	assert.ok(r.data.jobs.some((j) => j.id === jobId));
	assert.equal(typeof r.data.active, "number");
	assert.equal(r.data.jobs[0].input, undefined, "inputs are not listed");
});

await check("a finished job can be run again", async () => {
	const r = await trpc("abhashJobs.retry", { id: jobId }, cookie);
	assert.ok(r.ok, r.error);
	assert.notEqual(r.data.id, jobId);
	const c = await trpc("abhashJobs.cancel", { id: r.data.id }, cookie);
	assert.ok(c.ok, c.error);
	const done = await waitStatus(r.data.id, ["cancelled", "succeeded"]);
	assert.equal(done.status, "cancelled");
});

await check("the switch is audited", async () => {
	const rows =
		await sql`select 1 from audit_log where resource_name = 'jobs.enabled'`;
	assert.ok(rows.length > 0);
});

await check(
	"a member sees no one else's jobs and cannot switch the engine",
	async () => {
		const email = `jobs-member-${Date.now()}@sandbox.test`;
		const password = "Sandbox-pass-123";
		const created = await trpc(
			"user.createUserWithCredentials",
			{ email, password, role: "member" },
			cookie,
		);
		assert.ok(created.ok, created.error);
		const login = await auth("/sign-in/email", { email, password });
		assert.equal(login.status, 200, login.text);
		const member = login.cookie;
		const list = await q("abhashJobs.list", { limit: 50 }, member);
		assert.ok(list.ok, list.error);
		assert.equal(list.data.jobs.length, 0);
		const get = await q("abhashJobs.get", { id: jobId }, member);
		assert.equal(get.ok, false);
		const off = await trpc("abhashJobs.setEnabled", { enabled: false }, member);
		assert.equal(off.ok, false);
	},
);

await check("engine can be turned off again", async () => {
	const r = await trpc("abhashJobs.setEnabled", { enabled: false }, cookie);
	assert.ok(r.ok, r.error);
	const s = await q("abhashJobs.status");
	assert.equal(s.data.running, false);
});

await finish();
