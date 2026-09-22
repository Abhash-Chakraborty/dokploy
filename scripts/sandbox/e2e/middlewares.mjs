// Middlewares end to end: definitions written for Traefik, attached to
// application routers by scope, passwords never leaving the server, the
// dashboard reserved to the owner, and (with `sandbox.sh up --traefik`) a
// real Traefik loading them and gating a route.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auth, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const traefik = process.env.SANDBOX_TRAEFIK_URL;
const api = process.env.SANDBOX_TRAEFIK_API;
const dynamicDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/dokploy/.docker/traefik/dynamic",
);
const routerFile = join(dynamicDir, "e2e-middlewares.yml");
const dashboardFile = join(dynamicDir, "dokploy.yml");

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const q = (procedure, input, cookie = owner) =>
	trpc(procedure, input, cookie, "query");

const [{ organizationId }] = await sql`
	select m.organization_id as "organizationId" from member m
	join "user" u on u.id = m.user_id
	where u.email = 'owner@sandbox.test' and m.role = 'owner'`;
const prefix = `abhash-${createHash("sha1").update(organizationId).digest("hex").slice(0, 8)}`;
const definitions = join(dynamicDir, `${prefix}-middlewares.yml`);
const refOf = (name) => `${prefix}-${name}@file`;

const until = async (fn, what, ms = 15_000) => {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		last = await fn().catch((e) => e);
		if (last === true) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`timed out waiting for ${what} (${last})`);
};
const status = (host, headers = {}) =>
	new Promise((resolve, reject) => {
		const url = new URL(traefik);
		const req = request(
			{
				host: url.hostname,
				port: url.port,
				path: "/",
				headers: { host, ...headers },
			},
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		);
		req.on("error", reject);
		req.end();
	});

const mkApp = async (label) => {
	const project = await trpc(
		"project.create",
		{ name: `mw-${label}-${suffix}` },
		owner,
	);
	assert.ok(project.ok, project.error);
	const projectId = project.data.project?.projectId ?? project.data.projectId;
	const one = await q("project.one", { projectId });
	const environmentId = one.data.environments[0].environmentId;
	const app = await trpc(
		"application.create",
		{ name: `mw-${label}`, environmentId },
		owner,
	);
	assert.ok(app.ok, app.error);
	const domain = await trpc(
		"domain.create",
		{
			host: `mw-${label}-${suffix}.test`,
			port: 80,
			https: false,
			certificateType: "none",
			applicationId: app.data.applicationId,
			domainType: "application",
		},
		owner,
	);
	assert.ok(domain.ok, domain.error);
	const [row] =
		await sql`select "appName" from application where "applicationId" = ${app.data.applicationId}`;
	return {
		projectId,
		file: join(dynamicDir, `${row.appName}.yml`),
	};
};
const routerRefs = (file) => {
	const text = readFileSync(file, "utf8");
	return new Set(text.match(/abhash-[0-9a-f]{8}-[a-z0-9-]+@file/g) ?? []);
};
const find = async (name) =>
	(await q("middlewares.list", null)).data.find((row) => row.name === name);

const alpha = await mkApp("alpha");
const beta = await mkApp("beta");
const limit = `rate-${suffix}`;
const gate = `gate-${suffix}`;
const created = [];

await check(
	"a rate limit for every project is written for Traefik",
	async () => {
		const r = await trpc(
			"middlewares.create",
			{
				name: limit,
				config: { kind: "rateLimit", average: 50, burst: 20, period: "1s" },
				scope: "all",
			},
			owner,
		);
		assert.ok(r.ok, r.error);
		created.push(limit);
		assert.ok(
			r.data.servers.every((s) => s.ok),
			JSON.stringify(r.data.servers),
		);
		const yaml = readFileSync(definitions, "utf8");
		assert.match(yaml, new RegExp(`${prefix}-${limit}:\\n\\s+rateLimit:`));
		assert.match(yaml, /average: 50/);
	},
);

await check("every application router picks it up at once", async () => {
	assert.ok(routerRefs(alpha.file).has(refOf(limit)), "alpha");
	assert.ok(routerRefs(beta.file).has(refOf(limit)), "beta");
});

await check(
	"a password gate scoped to one project reaches only that project",
	async () => {
		const r = await trpc(
			"middlewares.create",
			{
				name: gate,
				config: {
					kind: "basicAuth",
					users: [{ username: "ops", password: "Gate-pass-1" }],
				},
				scope: "projects",
				projectIds: [alpha.projectId],
			},
			owner,
		);
		assert.ok(r.ok, r.error);
		created.push(gate);
		assert.ok(routerRefs(alpha.file).has(refOf(gate)), "alpha has it");
		assert.ok(!routerRefs(beta.file).has(refOf(gate)), "beta must not");
	},
);

await check("passwords are stored hashed and never sent back", async () => {
	const [row] =
		await sql`select config from abhash_traefik_middleware where name = ${gate} and organization_id = ${organizationId}`;
	assert.match(row.config.users[0], /^ops:\$2[aby]\$10\$/);
	const listed = await find(gate);
	assert.deepEqual(listed.config.users, [{ username: "ops", password: "" }]);
	assert.doesNotMatch(JSON.stringify(listed), /\$2[aby]\$/);
	const kept = await trpc(
		"middlewares.update",
		{
			id: listed.id,
			name: gate,
			config: { kind: "basicAuth", users: [{ username: "ops" }] },
			scope: "projects",
			projectIds: [alpha.projectId],
		},
		owner,
	);
	assert.ok(kept.ok, kept.error);
	const [after] =
		await sql`select config from abhash_traefik_middleware where id = ${listed.id}`;
	assert.equal(after.config.users[0], row.config.users[0]);
	const refused = await trpc(
		"middlewares.update",
		{
			id: listed.id,
			name: gate,
			config: { kind: "basicAuth", users: [{ username: "new-user" }] },
			scope: "projects",
			projectIds: [alpha.projectId],
		},
		owner,
	);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /Set a password for new-user/);
});

await check(
	"a project from another organization cannot be targeted",
	async () => {
		const listed = await find(gate);
		const r = await trpc(
			"middlewares.update",
			{
				id: listed.id,
				name: gate,
				config: { kind: "basicAuth", users: [{ username: "ops" }] },
				scope: "projects",
				projectIds: [alpha.projectId, "not-a-project-here"],
			},
			owner,
		);
		assert.ok(r.ok, r.error);
		assert.deepEqual((await find(gate)).projectIds, [alpha.projectId]);
	},
);

await check("invalid input is refused before anything is written", async () => {
	const before = readFileSync(definitions, "utf8");
	const bad = [
		{ kind: "ipAllowList", sourceRange: ["not an ip"] },
		{ kind: "custom", yaml: "a: 1\nb: 2\n" },
		{ kind: "custom", yaml: "headers: [unclosed" },
	];
	for (const config of bad) {
		const r = await trpc(
			"middlewares.create",
			{ name: `bad-${suffix}`, config },
			owner,
		);
		assert.equal(r.ok, false, JSON.stringify(config));
	}
	const dup = await trpc(
		"middlewares.create",
		{ name: limit, config: { kind: "compress" } },
		owner,
	);
	assert.equal(dup.ok, false);
	assert.match(dup.error, /already exists/);
	assert.equal(readFileSync(definitions, "utf8"), before);
});

await check(
	"only the owner can put a middleware in front of the dashboard",
	async () => {
		const email = `mw-admin-${suffix}@sandbox.test`;
		const password = "Sandbox-pass-123";
		const made = await trpc(
			"user.createUserWithCredentials",
			{ email, password, role: "admin" },
			owner,
		);
		assert.ok(made.ok, made.error);
		const admin = (await auth("/sign-in/email", { email, password })).cookie;
		const listed = await q("middlewares.list", null, admin);
		assert.ok(listed.ok, "admins manage middlewares");
		const r = await trpc(
			"middlewares.create",
			{
				name: `dash-${suffix}`,
				config: { kind: "compress" },
				applyToDashboard: true,
			},
			admin,
		);
		assert.equal(r.ok, false);
		assert.match(r.error, /Only the owner/);
	},
);

await check(
	"the owner's dashboard middleware lands on the dashboard router",
	async () => {
		const hadDashboard = existsSync(dashboardFile);
		if (!hadDashboard) {
			writeFileSync(
				dashboardFile,
				`http:
  routers:
    dokploy-router-app:
      rule: Host(\`dokploy.test\`)
      service: dokploy-service-app
      entryPoints: [web]
      middlewares: [keep-me@file]
  services:
    dokploy-service-app:
      loadBalancer:
        servers: [{ url: "http://dokploy:3000" }]
`,
			);
		}
		try {
			const name = `dash-${suffix}`;
			const r = await trpc(
				"middlewares.create",
				{
					name,
					config: { kind: "compress" },
					applyToDashboard: true,
				},
				owner,
			);
			assert.ok(r.ok, r.error);
			created.push(name);
			const text = readFileSync(dashboardFile, "utf8");
			assert.match(text, new RegExp(refOf(name)));
			if (!hadDashboard) assert.match(text, /keep-me@file/);
			const off = await trpc(
				"middlewares.setEnabled",
				{ id: (await find(name)).id, enabled: false },
				owner,
			);
			assert.ok(off.ok, off.error);
			assert.doesNotMatch(
				readFileSync(dashboardFile, "utf8"),
				new RegExp(refOf(name)),
			);
		} finally {
			if (!hadDashboard) rmSync(dashboardFile, { force: true });
		}
	},
);

await check(
	"turning one off drops it from routers but keeps it defined",
	async () => {
		const r = await trpc(
			"middlewares.setEnabled",
			{ id: (await find(limit)).id, enabled: false },
			owner,
		);
		assert.ok(r.ok, r.error);
		assert.ok(!routerRefs(alpha.file).has(refOf(limit)));
		assert.match(
			readFileSync(definitions, "utf8"),
			new RegExp(
				`${prefix}-${limit}:\\n\\s+headers:\\n\\s+customRequestHeaders:\\n\\s+X-Dokploy-Middleware-Off`,
			),
		);
		await trpc(
			"middlewares.setEnabled",
			{ id: (await find(limit)).id, enabled: true },
			owner,
		);
	},
);

if (traefik && api) {
	await check("Traefik loads the definitions", async () => {
		for (const name of [limit, gate]) {
			await until(async () => {
				const res = await fetch(
					`${api}/api/http/middlewares/${encodeURIComponent(refOf(name))}`,
				);
				return res.ok || res.status;
			}, `${name} in Traefik`);
		}
	});

	await check(
		"the password gate refuses strangers and lets ops in",
		async () => {
			mkdirSync(dynamicDir, { recursive: true });
			writeFileSync(
				routerFile,
				`http:
  routers:
    e2e-mw-gated:
      rule: Host(\`gated.test\`)
      service: e2e-mw-whoami
      middlewares: ["${refOf(gate)}", "${refOf(limit)}"]
  services:
    e2e-mw-whoami:
      loadBalancer:
        servers: [{ url: "http://whoami:80" }]
`,
			);
			await until(
				async () => (await status("gated.test")) === 401 || "not 401",
				"401",
			);
			const basic = `Basic ${Buffer.from("ops:Gate-pass-1").toString("base64")}`;
			assert.equal(await status("gated.test", { authorization: basic }), 200);
			const wrong = `Basic ${Buffer.from("ops:nope").toString("base64")}`;
			assert.equal(await status("gated.test", { authorization: wrong }), 401);
		},
	);
} else {
	console.log("skip Traefik checks: start the sandbox with --traefik");
}

await check(
	"deleting keeps a no-op definition and clears the routers",
	async () => {
		for (const name of created) {
			const row = await find(name);
			const r = await trpc("middlewares.remove", { id: row.id }, owner);
			assert.ok(r.ok, r.error);
		}
		const yaml = readFileSync(definitions, "utf8");
		assert.match(
			yaml,
			new RegExp(
				`${prefix}-${gate}:\\n\\s+headers:\\n\\s+customRequestHeaders:\\n\\s+X-Dokploy-Middleware-Off`,
			),
		);
		assert.equal(routerRefs(alpha.file).size, 0);
		assert.equal(await find(gate), undefined);
		if (traefik && api) {
			// Traefik refuses the whole file over one bad entry, so the no-op
			// left behind must still load.
			await until(async () => {
				const res = await fetch(
					`${api}/api/http/middlewares/${encodeURIComponent(refOf(gate))}`,
				);
				const body = await res.json().catch(() => ({}));
				return (res.ok && body.status === "enabled") || res.status;
			}, "no-op in Traefik");
		}
		const revived = await trpc(
			"middlewares.create",
			{ name: gate, config: { kind: "compress" } },
			owner,
		);
		assert.ok(revived.ok, revived.error);
		await trpc("middlewares.remove", { id: (await find(gate)).id }, owner);
	},
);

rmSync(routerFile, { force: true });
await finish();
