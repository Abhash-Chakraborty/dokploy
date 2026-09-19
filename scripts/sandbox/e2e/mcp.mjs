// The agent surface end to end: MCP tools over the wire with an agent key,
// approvals for destructive tools, and a signed webhook delivery.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { base, runChecks, signInOwner, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);

const mcp = async (key, method, params) => {
	const res = await fetch(`${base}/api/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json();
};

const agent = await trpc(
	"agents.create",
	{ name: `MCP ${suffix}`, description: "e2e", role: "admin" },
	owner,
);
assert.ok(agent.ok, agent.error);
const keyResult = await trpc(
	"agents.createKey",
	{
		agentId: agent.data.id,
		name: "mcp",
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
assert.ok(keyResult.ok, keyResult.error);
const key = keyResult.data.key;

await check("the tool list includes write tools, marked as such", async () => {
	const body = await mcp(key, "tools/list", {});
	const tools = body.result.tools;
	const names = tools.map((tool) => tool.name);
	for (const expected of [
		"list_projects",
		"deploy_application",
		"run_on_servers",
		"apply_firewall",
		"backup_health",
		"wait_for_approval",
		"list_secrets",
	]) {
		assert.ok(names.includes(expected), `missing ${expected}`);
	}
	const exec = tools.find((tool) => tool.name === "run_on_servers");
	assert.equal(exec.annotations.destructiveHint, true);
	const list = tools.find((tool) => tool.name === "list_projects");
	assert.equal(list.annotations.readOnlyHint, true);
});

await check("a read tool works through MCP", async () => {
	const body = await mcp(key, "tools/call", {
		name: "list_fleet",
		arguments: {},
	});
	assert.ok(!body.error, JSON.stringify(body.error));
	assert.ok(body.result.content?.[0]?.text);
});

await check("secrets are listed without their values", async () => {
	await trpc("vault.setEnabled", { enabled: true }, owner);
	const name = `MCP_SECRET_${suffix.toUpperCase()}`;
	const created = await trpc(
		"vault.create",
		{
			name,
			description: "e2e",
			value: "never-show-this",
			tags: [],
			expiresAt: null,
			rotateEveryDays: null,
			scopeType: "organization",
		},
		owner,
	);
	assert.ok(created.ok, created.error);
	const body = await mcp(key, "tools/call", {
		name: "list_secrets",
		arguments: {},
	});
	const text = body.result.content[0].text;
	assert.match(text, new RegExp(name));
	assert.ok(!text.includes("never-show-this"));
});

await check(
	"a destructive tool waits for a person, and can be rejected",
	async () => {
		await trpc("abhashJobs.setEnabled", { enabled: true }, owner);
		const body = await mcp(key, "tools/call", {
			name: "run_playbook",
			arguments: { id: "does-not-exist", checkMode: false },
		});
		assert.ok(!body.error, JSON.stringify(body.error));
		const result = JSON.parse(body.result.content[0].text);
		assert.equal(result.status, "approval_required");
		assert.ok(result.approvalId);

		// The agent can watch its own request, but never decide it.
		const watched = await mcp(key, "tools/call", {
			name: "wait_for_approval",
			arguments: { approvalId: result.approvalId },
		});
		assert.ok(!watched.error, JSON.stringify(watched.error));

		const rejected = await trpc(
			"agents.approvals.decide",
			{ id: result.approvalId, approve: false, reason: "e2e" },
			owner,
		);
		assert.ok(rejected.ok, rejected.error);
		assert.equal(rejected.data.status, "rejected");
	},
);

await check("a webhook delivery is signed and verifiable", async () => {
	const received = [];
	const secret = `whsec-${suffix}`;
	const receiver = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			received.push({
				body: raw,
				signature: req.headers["x-dokploy-signature"],
				event: req.headers["x-dokploy-event"],
			});
			res.writeHead(200).end("ok");
		});
	});
	await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${receiver.address().port}/hook`;

	const saved = await trpc(
		"agents.webhooks.save",
		{
			name: `hook-${suffix}`,
			url,
			secretRef: secret,
			events: ["job.succeeded", "approval.requested"],
			enabled: true,
		},
		owner,
	);
	assert.ok(saved.ok, saved.error);

	const sent = await trpc("agents.webhooks.test", { id: saved.data.id }, owner);
	assert.ok(sent.ok, sent.error);

	const deadline = Date.now() + 30_000;
	while (received.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(received.length >= 1, true, "nothing was delivered");
	const delivery = received[0];
	const expected = `sha256=${createHmac("sha256", secret).update(delivery.body).digest("hex")}`;
	assert.equal(delivery.signature, expected, "the signature must verify");
	assert.equal(delivery.event, "job.succeeded");
	receiver.close();
	await trpc("agents.webhooks.remove", { id: saved.data.id }, owner);
});

await trpc("abhashJobs.setEnabled", { enabled: false }, owner);
await trpc("vault.setEnabled", { enabled: false }, owner);
await trpc("agents.remove", { id: agent.data.id }, owner);
await finish();
