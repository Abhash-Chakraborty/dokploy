// Agent identities end to end: a real API key over HTTP, its policy limits,
// credential redaction, and the human approval gate for destructive jobs.
import assert from "node:assert/strict";
import { base, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);

/** Same shape as lib's trpc(), but authenticating with an API key. */
const asKey = async (procedure, input, key, kind = "mutation") => {
	const url =
		kind === "query"
			? `${base}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`
			: `${base}/api/trpc/${procedure}`;
	const res = await fetch(url, {
		method: kind === "query" ? "GET" : "POST",
		headers: {
			"content-type": "application/json",
			origin: base,
			"x-api-key": key,
		},
		body:
			kind === "query" ? undefined : JSON.stringify({ json: input ?? null }),
	});
	const body = await res.json().catch(() => ({}));
	return body.error
		? { ok: false, status: res.status, error: body.error.json?.message ?? "" }
		: { ok: true, data: body.result?.data?.json };
};

const newAgent = async (name, policy) => {
	const agent = await trpc(
		"agents.create",
		{ name, description: "e2e", role: "admin" },
		owner,
	);
	assert.ok(agent.ok, agent.error);
	const key = await trpc(
		"agents.createKey",
		{ agentId: agent.data.id, name: "e2e", expiresInDays: 1, policy },
		owner,
	);
	assert.ok(key.ok, key.error);
	return { agent: agent.data, key: key.data.key };
};

const full = await newAgent(`Agent Full ${suffix}`, {
	readOnly: false,
	allow: [],
	ipAllowList: [],
	approvalMode: "destructive",
});

await check(
	"an agent key authenticates and is recorded as an agent",
	async () => {
		const projects = await asKey("project.all", null, full.key, "query");
		assert.ok(projects.ok, projects.error);
		assert.ok(Array.isArray(projects.data));
	},
);

await check("credentials are masked in what an agent reads", async () => {
	const project = await trpc(
		"project.create",
		{ name: `agent-${suffix}` },
		owner,
	);
	assert.ok(project.ok, project.error);
	const projectId = project.data.project?.projectId ?? project.data.projectId;
	const one = await trpc("project.one", { projectId }, owner, "query");
	const environmentId = one.data.environments[0].environmentId;
	const app = await trpc(
		"application.create",
		{ name: `app-${suffix}`, environmentId },
		owner,
	);
	assert.ok(app.ok, app.error);
	const applicationId = app.data.applicationId;
	const saved = await trpc(
		"application.saveEnvironment",
		{
			applicationId,
			env: "TOKEN=super-secret-value",
			buildArgs: null,
			buildSecrets: null,
			createEnvFile: false,
		},
		owner,
	);
	assert.ok(saved.ok, saved.error);

	const asOwner = await trpc(
		"application.one",
		{ applicationId },
		owner,
		"query",
	);
	assert.match(asOwner.data.env, /super-secret-value/, "people still see it");

	const asAgent = await asKey(
		"application.one",
		{ applicationId },
		full.key,
		"query",
	);
	assert.ok(asAgent.ok, asAgent.error);
	assert.match(asAgent.data.env, /TOKEN=/, "names stay");
	assert.ok(
		!JSON.stringify(asAgent.data).includes("super-secret-value"),
		"values never reach an agent",
	);
});

await check("a read-only key cannot change anything", async () => {
	const readOnly = await newAgent(`Agent RO ${suffix}`, {
		readOnly: true,
		allow: [],
		ipAllowList: [],
		approvalMode: "destructive",
	});
	const read = await asKey("project.all", null, readOnly.key, "query");
	assert.ok(read.ok, read.error);
	const write = await asKey(
		"project.create",
		{ name: `nope-${suffix}` },
		readOnly.key,
	);
	assert.equal(write.ok, false);
	assert.match(write.error, /read-only/i);
});

await check("a key limited to some calls cannot use the others", async () => {
	const scoped = await newAgent(`Agent Scoped ${suffix}`, {
		readOnly: false,
		allow: ["project.*"],
		ipAllowList: [],
		approvalMode: "destructive",
	});
	const allowed = await asKey("project.all", null, scoped.key, "query");
	assert.ok(allowed.ok, allowed.error);
	const blocked = await asKey("server.all", null, scoped.key, "query");
	assert.equal(blocked.ok, false);
	assert.match(blocked.error, /may not call/);
});

await check("a paused agent stops working immediately", async () => {
	const paused = await newAgent(`Agent Paused ${suffix}`, {
		readOnly: false,
		allow: [],
		ipAllowList: [],
		approvalMode: "none",
	});
	await new Promise((r) => setTimeout(r, 200));
	const before = await asKey("project.all", null, paused.key, "query");
	assert.ok(before.ok, before.error);
	const off = await trpc(
		"agents.update",
		{ id: paused.agent.id, enabled: false },
		owner,
	);
	assert.ok(off.ok, off.error);
	await new Promise((r) => setTimeout(r, 11_000));
	const after = await asKey("project.all", null, paused.key, "query");
	assert.equal(after.ok, false);
	assert.match(after.error, /paused/i);
});

await check("a destructive job waits for a person, then runs", async () => {
	const on = await trpc("abhashJobs.setEnabled", { enabled: true }, owner);
	assert.ok(on.ok, on.error);

	const asked = await asKey(
		"abhashJobs.run",
		{ type: "vault.convert-credentials", input: { enabled: true } },
		full.key,
	);
	assert.ok(asked.ok, asked.error);
	assert.equal(asked.data.jobId, null, "nothing runs before approval");
	const approvalId = asked.data.approvalId;
	assert.ok(approvalId);

	const pending = await trpc(
		"agents.approvals.list",
		{ status: "pending" },
		owner,
		"query",
	);
	assert.ok(pending.data.some((a) => a.id === approvalId));

	const selfApprove = await asKey(
		"agents.approvals.decide",
		{ id: approvalId, approve: true },
		full.key,
	);
	assert.equal(selfApprove.ok, false, "an agent cannot approve itself");

	const decided = await trpc(
		"agents.approvals.decide",
		{ id: approvalId, approve: true },
		owner,
	);
	assert.ok(decided.ok, decided.error);
	assert.equal(decided.data.status, "executed");
	assert.ok(decided.data.jobId);

	const deadline = Date.now() + 60_000;
	let job;
	while (Date.now() < deadline) {
		const result = await trpc(
			"abhashJobs.get",
			{ id: decided.data.jobId },
			owner,
			"query",
		);
		if (result.ok && ["succeeded", "failed"].includes(result.data.status)) {
			job = result.data;
			break;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	assert.equal(job?.status, "succeeded", job?.error);

	// Put the instance back the way it was.
	const back = await trpc(
		"vault.setCredentialEncryption",
		{ enabled: false },
		owner,
	);
	assert.ok(back.ok, back.error);
	await trpc("abhashJobs.setEnabled", { enabled: false }, owner);
});

await check("a rejected request never runs", async () => {
	const asked = await asKey(
		"abhashJobs.run",
		{ type: "vault.convert-credentials", input: { enabled: true } },
		full.key,
	);
	assert.ok(asked.ok, asked.error);
	const rejected = await trpc(
		"agents.approvals.decide",
		{ id: asked.data.approvalId, approve: false, reason: "not now" },
		owner,
	);
	assert.ok(rejected.ok, rejected.error);
	assert.equal(rejected.data.status, "rejected");
	assert.equal(rejected.data.jobId, null);
});

await check("agent actions are audited as the agent", async () => {
	const rows =
		await sql`select 1 from audit_log where metadata like '%"actorType":"agent"%' limit 1`;
	assert.ok(rows.length > 0, "the audit log records the agent as the actor");
});

await check("MCP hands an agent no credentials either", async () => {
	const res = await fetch(`${base}/api/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": full.key },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "list_projects", arguments: {} },
		}),
	});
	const body = await res.json();
	assert.ok(!body.error, JSON.stringify(body.error));
	assert.ok(!JSON.stringify(body).includes("super-secret-value"));
});

await finish();
