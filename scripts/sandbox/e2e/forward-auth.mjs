// Forward-auth gates against the sandbox Traefik (`sandbox.sh up --traefik`):
// the generated middleware must load in a real Traefik and gate a route.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const traefik = process.env.SANDBOX_TRAEFIK_URL;
const api = process.env.SANDBOX_TRAEFIK_API;
assert.ok(traefik && api, "start the sandbox with --traefik");
const dynamicDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/dokploy/.docker/traefik/dynamic",
);
const gateFile = join(dynamicDir, "abhash-forward-auth.yml");
const routerFile = join(dynamicDir, "e2e-forward-auth.yml");

const cookie = await signInOwner();
const { check, finish } = runChecks();
const run = Date.now().toString(36);
const slug = `e2e-${run}`;
const ref = `abhash-fa-${slug}@file`;

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
// fetch() drops a custom Host header, so route by Host with node:http.
const status = (host) =>
	new Promise((resolve, reject) => {
		const url = new URL(traefik);
		const req = request(
			{ host: url.hostname, port: url.port, path: "/", headers: { host } },
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		);
		req.on("error", reject);
		req.end();
	});

let gateId = "";
await check("creating a gate writes a valid middleware file", async () => {
	const r = await trpc(
		"forwardAuth.create",
		{
			name: "E2E gate",
			slug,
			kind: "generic",
			address: "http://fa-deny:5678",
			trustForwardHeader: true,
		},
		cookie,
	);
	assert.ok(r.ok, r.error);
	assert.ok(
		r.data.every((x) => x.ok),
		JSON.stringify(r.data),
	);
	const yaml = readFileSync(gateFile, "utf8");
	assert.match(yaml, new RegExp(`abhash-fa-${slug}:`));
	assert.match(yaml, /address: http:\/\/fa-deny:5678/);
	gateId = (
		await trpc("forwardAuth.list", undefined, cookie, "query")
	).data.find((g) => g.slug === slug).id;
});

await check("Traefik loads the middleware", async () => {
	await until(async () => {
		const res = await fetch(
			`${api}/api/http/middlewares/${encodeURIComponent(ref)}`,
		);
		return res.ok || res.status;
	}, "middleware in Traefik");
});

await check(
	"a protected route is refused while an unprotected one is served",
	async () => {
		mkdirSync(dynamicDir, { recursive: true });
		writeFileSync(
			routerFile,
			`http:
  routers:
    e2e-open:
      rule: Host(\`open.test\`)
      service: e2e-whoami
    e2e-protected:
      rule: Host(\`protected.test\`)
      service: e2e-whoami
      middlewares: ["${ref}"]
  services:
    e2e-whoami:
      loadBalancer:
        servers: [{ url: "http://whoami:80" }]
`,
		);
		await until(
			async () => (await status("open.test")) === 200 || "open",
			"open route",
		);
		await until(
			async () => (await status("protected.test")) === 401 || "protected",
			"401",
		);
	},
);

await check(
	"pointing the gate at an allowing service lets requests through",
	async () => {
		const r = await trpc(
			"forwardAuth.update",
			{
				id: gateId,
				name: "E2E gate",
				kind: "generic",
				address: "http://fa-allow:5678",
				trustForwardHeader: true,
			},
			cookie,
		);
		assert.ok(r.ok, r.error);
		await until(
			async () => (await status("protected.test")) === 200 || "still refused",
			"200",
		);
	},
);

await check("a gate in use by a domain cannot be deleted", async () => {
	const [app] = await sql`
		select a."applicationId" as id from application a
		join environment e on e."environmentId" = a."environmentId"
		join project p on p."projectId" = e."projectId"
		join member m on m.organization_id = p."organizationId"
		join "user" u on u.id = m.user_id
		where u.email = 'owner@sandbox.test' limit 1`;
	assert.ok(app, "needs an application from the rbac-api suite");
	await sql`insert into domain ("domainId", host, "applicationId", "createdAt", middlewares, "domainType")
		values (${`d-${run}`}, ${`app-${run}.test`}, ${app.id}, now()::text, ${[ref]}, 'application')`;
	const r = await trpc("forwardAuth.remove", { id: gateId }, cookie);
	assert.equal(r.ok, false);
	assert.match(r.error, /app-.*\.test/);
	await sql`delete from domain where "domainId" = ${`d-${run}`}`;
});

await check("deleting the last gate removes the middleware file", async () => {
	rmSync(routerFile, { force: true });
	const others =
		await sql`select count(*)::int n from abhash_forward_auth where slug <> ${slug}`;
	const r = await trpc("forwardAuth.remove", { id: gateId }, cookie);
	assert.ok(r.ok, r.error);
	if (others[0].n === 0) {
		assert.throws(() => readFileSync(gateFile, "utf8"));
	} else {
		assert.doesNotMatch(readFileSync(gateFile, "utf8"), new RegExp(slug));
	}
});

rmSync(routerFile, { force: true });
await finish();
