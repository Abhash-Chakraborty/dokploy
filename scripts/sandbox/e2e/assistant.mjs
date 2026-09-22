// The in-app assistant end to end against a scripted OpenAI-compatible model:
// it must look things up through real tools with the user's own permissions,
// never run a change by itself, and run a proposed change only when confirmed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);

// A stand-in model: it calls list_projects, answers from what the tool
// returned, and asks to deploy when told to. It also records what it was
// offered, so the test can see which tools each mode exposes.
const seen = [];
const completion = (message, finish) => ({
	id: `cmpl-${seen.length}`,
	object: "chat.completion",
	created: Math.floor(Date.now() / 1000),
	model: "scripted",
	choices: [{ index: 0, message, finish_reason: finish }],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const call = (name, args) =>
	completion(
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: `call_${name}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		},
		"tool_calls",
	);
const model = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		const request = JSON.parse(body || "{}");
		seen.push(request);
		const messages = request.messages ?? [];
		const last = messages.at(-1);
		const user = [...messages].reverse().find((m) => m.role === "user");
		let reply;
		if (last?.role === "tool") {
			const names = [
				...String(last.content).matchAll(/\\?"name\\?":\\?"([^"\\]+)/g),
			].map((m) => m[1]);
			reply = completion(
				{
					role: "assistant",
					content: `Tool said: ${last.content.includes("awaiting_confirmation") ? "awaiting confirmation" : names.join(", ")}`,
				},
				"stop",
			);
		} else if (/deploy (\S+)/.test(user?.content ?? "")) {
			const applicationId = user.content.match(/deploy (\S+)/)[1];
			reply = call("deploy_application", { applicationId });
		} else {
			reply = call("list_projects", {});
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(reply));
	});
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${model.address().port}/v1`;

const projectName = `Assistant probe ${suffix}`;
const project = await trpc(
	"project.create",
	{ name: projectName, description: "" },
	owner,
);
assert.ok(project.ok, project.error);

let aiId;
try {
	await check("an OpenAI-compatible provider can be added", async () => {
		const created = await trpc(
			"ai.create",
			{
				name: `scripted-${suffix}`,
				apiUrl,
				apiKey: "sk-test",
				model: "scripted",
				isEnabled: true,
			},
			owner,
		);
		assert.ok(created.ok, created.error);
		const [row] =
			await sql`select "aiId" from ai where name = ${`scripted-${suffix}`}`;
		aiId = row.aiId;
	});

	await check("read mode answers from real data through tools", async () => {
		const started = Date.now();
		const r = await trpc(
			"ai.chat",
			{ aiId, message: "what projects do I have?", permission: "read" },
			owner,
		);
		assert.ok(r.ok, r.error);
		assert.match(r.data.reply, new RegExp(projectName));
		assert.deepEqual(
			r.data.tools.map((t) => t.tool),
			["list_projects"],
		);
		assert.equal(r.data.actions.length, 0);
		const offered = seen.at(-2).tools.map((t) => t.function.name);
		assert.ok(offered.includes("list_projects"));
		assert.ok(
			!offered.includes("deploy_application"),
			"read mode must not offer tools that change things",
		);
		// Two model round trips plus a real tool call, locally.
		assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
	});

	const app = await trpc(
		"application.create",
		{
			name: `probe-${suffix}`,
			appName: `probe-${suffix}`,
			description: "",
			environmentId: project.data.environment?.environmentId,
		},
		owner,
	);
	assert.ok(app.ok, app.error);
	const applicationId = app.data.applicationId;
	const deployments = async () =>
		(
			await sql`select count(*)::int n from deployment where "applicationId" = ${applicationId}`
		)[0].n;

	await check("write mode proposes a deploy but does not run it", async () => {
		const before = await deployments();
		const r = await trpc(
			"ai.chat",
			{ aiId, message: `deploy ${applicationId}`, permission: "write" },
			owner,
		);
		assert.ok(r.ok, r.error);
		assert.equal(r.data.actions.length, 1);
		assert.equal(r.data.actions[0].tool, "deploy_application");
		assert.deepEqual(r.data.actions[0].args, { applicationId });
		assert.match(r.data.reply, /awaiting confirmation/);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.equal(await deployments(), before, "nothing ran on its own");
	});

	await check(
		"a confirmed action runs with the user's permissions",
		async () => {
			const before = await deployments();
			const r = await trpc(
				"ai.runAction",
				{ tool: "deploy_application", args: { applicationId } },
				owner,
			);
			assert.ok(r.ok, r.error);
			for (let i = 0; i < 20 && (await deployments()) === before; i++) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			assert.ok((await deployments()) > before, "the deploy was queued");
		},
	);

	await check("runAction refuses read-only and unknown tools", async () => {
		const read = await trpc(
			"ai.runAction",
			{ tool: "list_projects", args: {} },
			owner,
		);
		assert.equal(read.ok, false);
		const unknown = await trpc(
			"ai.runAction",
			{ tool: "rm_rf", args: {} },
			owner,
		);
		assert.equal(unknown.ok, false);
	});

	await check("the assistant needs a session", async () => {
		const anonymous = await trpc(
			"ai.chat",
			{ aiId, message: "hi", permission: "read" },
			"",
		);
		assert.equal(anonymous.ok, false);
		assert.equal(anonymous.status, 401);
	});
} finally {
	if (aiId) await trpc("ai.delete", { aiId }, owner);
	await trpc(
		"project.remove",
		{ projectId: project.data.project?.projectId ?? project.data.projectId },
		owner,
	).catch(() => {});
	model.close();
}

await finish();
