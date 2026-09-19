// The mesh end to end, against a stand-in NetBird API: the token comes from
// the vault, only one provider is active, the plan is shown before anything
// is created, and peers are matched to servers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input) => trpc(procedure, input, owner, "query");

const groups = [];
const policies = [];
const peers = [];
const seen = [];

const api = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		const body = raw ? JSON.parse(raw) : null;
		seen.push({
			method: req.method,
			path: req.url,
			auth: req.headers.authorization,
		});
		const reply = (value) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};
		if (req.url === "/api/groups" && req.method === "GET") return reply(groups);
		if (req.url === "/api/groups" && req.method === "POST") {
			const group = { id: `g${groups.length + 1}`, name: body.name };
			groups.push(group);
			return reply(group);
		}
		if (req.url === "/api/policies" && req.method === "GET")
			return reply(policies);
		if (req.url === "/api/policies" && req.method === "POST") {
			const policy = {
				id: `pol${policies.length + 1}`,
				name: body.name,
				enabled: true,
			};
			policies.push(policy);
			return reply(policy);
		}
		if (req.url === "/api/peers") return reply(peers);
		if (req.url === "/api/setup-keys")
			return reply({ key: "SETUP", expires: "2030-01-01" });
		res.writeHead(404, { "content-type": "application/json" });
		res.end("{}");
	});
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${api.address().port}`;

// A server for the peer matching to find.
const keyPath = process.env.SANDBOX_FLEET_KEY;
const fleet = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean);
const [firstHost] = fleet;
const [, firstAddress] = (firstHost ?? "x=127.0.0.1").split("=");
const sshKey = await trpc(
	"sshKey.create",
	{
		name: `mesh-${suffix}`,
		description: "mesh e2e",
		privateKey: readFileSync(keyPath, "utf8"),
		publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
		organizationId: "",
	},
	owner,
);
assert.ok(sshKey.ok, sshKey.error);
const keys = await q("sshKey.all");
const sshKeyId = keys.data.find(
	(key) => key.name === `mesh-${suffix}`,
).sshKeyId;
const serverName = `mesh-server-${suffix}`;
const createdServer = await trpc(
	"server.create",
	{
		name: serverName,
		description: "mesh e2e",
		ipAddress: firstAddress,
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
	},
	owner,
);
assert.ok(createdServer.ok, createdServer.error);
const serverId = createdServer.data.serverId;

await trpc("vault.setEnabled", { enabled: true }, owner);
const secretName = `NETBIRD_TOKEN_${suffix.toUpperCase()}`;
const secret = await trpc(
	"vault.create",
	{
		name: secretName,
		description: "mesh e2e",
		value: "netbird-pat-value",
		tags: [],
		expiresAt: null,
		rotateEveryDays: null,
		scopeType: "organization",
	},
	owner,
);
assert.ok(secret.ok, secret.error);

let providerId;
await check("a provider stores only a reference to the token", async () => {
	const saved = await trpc(
		"mesh.save",
		{
			kind: "netbird",
			name: `NetBird ${suffix}`,
			baseUrl,
			tokenRef: `\${{secret.${secretName}}}`,
			settings: {
				groupPrefix: "dokploy",
				manageDns: false,
				sshPort: 22,
				swarmOverMesh: false,
			},
		},
		owner,
	);
	assert.ok(saved.ok, saved.error);
	providerId = saved.data.id;
	const rows =
		await sql`select token_ref from abhash_mesh_provider where id = ${providerId}`;
	assert.match(rows[0].token_ref, /secret\./);
	assert.ok(!JSON.stringify(rows[0]).includes("netbird-pat-value"));
});

await check("testing the provider uses the vault token", async () => {
	const result = await trpc("mesh.test", { id: providerId }, owner);
	assert.ok(result.ok, result.error);
	assert.match(result.data.detail, /Reachable/);
	assert.equal(seen.at(-1).auth, "Token netbird-pat-value");
});

await check(
	"the plan shows what it would create, and creates nothing",
	async () => {
		const planned = await trpc("mesh.plan", { id: providerId }, owner);
		assert.ok(planned.ok, planned.error);
		assert.ok(
			planned.data.plan.create.some((line) => line.includes("dokploy-servers")),
		);
		assert.equal(groups.length, 0, "a plan must not create anything");
	},
);

await check("only one provider can be active", async () => {
	const second = await trpc(
		"mesh.save",
		{
			kind: "headscale",
			name: `Headscale ${suffix}`,
			baseUrl,
			tokenRef: `\${{secret.${secretName}}}`,
			settings: {
				groupPrefix: "dokploy",
				manageDns: false,
				sshPort: 22,
				swarmOverMesh: false,
			},
		},
		owner,
	);
	assert.ok(second.ok, second.error);
	await trpc("mesh.setActive", { id: providerId }, owner);
	await trpc("mesh.setActive", { id: second.data.id }, owner);
	const list = await q("mesh.list");
	const active = list.data.providers.filter((provider) => provider.active);
	assert.equal(active.length, 1);
	assert.equal(active[0].id, second.data.id);
	// Back to NetBird for the rest of the checks.
	await trpc("mesh.setActive", { id: providerId }, owner);
	const removed = await trpc("mesh.remove", { id: second.data.id }, owner);
	assert.ok(removed.ok, removed.error);
});

await check(
	"peers already in the mesh are adopted, not enrolled again",
	async () => {
		peers.push({
			id: "peer-1",
			name: `dokploy-${serverName}`,
			ip: "100.97.5.5",
			dns_label: `dokploy-${serverName}.netbird.selfhosted`,
			connected: true,
			version: "0.76.3",
		});
		const synced = await trpc("mesh.sync", null, owner);
		assert.ok(synced.ok, synced.error);
		assert.equal(synced.data.matched, 1);
		const list = await q("mesh.list");
		const row = list.data.servers.find((entry) => entry.serverId === serverId);
		assert.equal(row.mesh.meshIp, "100.97.5.5");
		assert.equal(row.mesh.adopted, true);
		assert.equal(row.mesh.status, "connected");
	},
);

await check("an active provider cannot be deleted by accident", async () => {
	const removed = await trpc("mesh.remove", { id: providerId }, owner);
	assert.equal(removed.ok, false);
	assert.match(removed.error, /deactivate|another provider/i);
});

await trpc("mesh.setActive", { id: null }, owner);
await trpc("mesh.remove", { id: providerId }, owner);
await trpc("server.remove", { serverId }, owner);
await trpc("sshKey.remove", { sshKeyId }, owner);
await trpc("vault.setEnabled", { enabled: false }, owner);
api.close();
await finish();
