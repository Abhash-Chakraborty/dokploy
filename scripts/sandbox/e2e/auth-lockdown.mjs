// End-to-end checks for the auth guard against a running sandbox app:
//   scripts/sandbox/sandbox.sh exec -- node scripts/sandbox/e2e/auth-lockdown.mjs
// Expects a fresh sandbox (it registers the first owner if none exists).
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const appRequire = createRequire(
	new URL("../../../apps/dokploy/package.json", import.meta.url),
);
const { default: postgres } = await import(appRequire.resolve("postgres"));

const base = process.env.BETTER_AUTH_URL;
const dbUrl = process.env.SANDBOX_DATABASE_URL;
assert.ok(base?.startsWith("http://127.0.0.1:"), "run through sandbox.sh exec");
assert.ok(dbUrl?.includes("@127.0.0.1:"), "run through sandbox.sh exec");

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
const owner = { email: "owner@sandbox.test", password: "Sandbox-pass-123" };

const call = async (path, body, cookie) => {
	const res = await fetch(`${base}/api/auth${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"content-type": "application/json",
			origin: base,
			...(cookie ? { cookie } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
	const setCookie = res.headers.getSetCookie?.() ?? [];
	return {
		status: res.status,
		text: await res.text(),
		cookie: setCookie.map((c) => c.split(";")[0]).join("; "),
	};
};

const setMethods = async (config) => {
	await sql`update "webServerSettings" set "authMethodsConfig" = ${sql.json(config)}`;
	// The guard caches the config for 10s.
	await new Promise((r) => setTimeout(r, 10_500));
};

const results = [];
const check = async (name, fn) => {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e.message}`);
	}
};

const [{ n }] =
	await sql`select count(*)::int n from member where role = 'owner'`;
if (n === 0) {
	const r = await call("/sign-up/email", { ...owner, name: "Owner" });
	assert.equal(r.status, 200, r.text);
}
const signIn = await call("/sign-in/email", owner);
assert.equal(signIn.status, 200, signIn.text);
const session = signIn.cookie;

await check("sign-up is closed once an owner exists", async () => {
	const r = await call("/sign-up/email", {
		email: "intruder@sandbox.test",
		password: "Sandbox-pass-123",
		name: "Intruder",
	});
	assert.notEqual(r.status, 200);
});

for (const [path, body] of [
	[
		"/sso/register",
		{
			providerId: "evil",
			issuer: "https://evil.example",
			domain: "sandbox.test",
			oidcConfig: {
				clientId: "a",
				clientSecret: "b",
				skipDiscovery: true,
				authorizationEndpoint: "https://evil.example/auth",
				tokenEndpoint: "https://evil.example/token",
				jwksEndpoint: "https://evil.example/jwks",
			},
		},
	],
	["/sign-in/sso", { email: owner.email, callbackURL: "/" }],
	["/scim/generate-token", { providerId: "evil" }],
	[
		"/organization/create-role",
		{ role: "evil", permission: { project: ["create"] } },
	],
	["/organization/update-member-role", { memberId: "x", role: "owner" }],
]) {
	await check(`HTTP ${path} is unreachable`, async () => {
		const r = await call(path, body, session);
		assert.equal(r.status, 404, `${r.status} ${r.text}`);
	});
}

await check("no SSO provider or SCIM connection was created", async () => {
	const [{ sso }] = await sql`select count(*)::int sso from sso_provider`;
	const [{ scim }] = await sql`select count(*)::int scim from scim_provider`;
	assert.equal(sso + scim, 0);
});

await check(
	"disabled email/password sign-in is rejected by the server",
	async () => {
		await setMethods({
			emailPassword: false,
			github: true,
			google: true,
			passkey: true,
		});
		const r = await call("/sign-in/email", owner);
		assert.equal(r.status, 403, `${r.status} ${r.text}`);
	},
);

await check("disabled GitHub sign-in is rejected by the server", async () => {
	await setMethods({
		emailPassword: true,
		github: false,
		google: true,
		passkey: true,
	});
	const r = await call("/sign-in/social", {
		provider: "github",
		callbackURL: "/",
	});
	assert.equal(r.status, 403, `${r.status} ${r.text}`);
});

await check("re-enabled email/password sign-in works", async () => {
	await setMethods({
		emailPassword: true,
		github: true,
		google: true,
		passkey: true,
	});
	const r = await call("/sign-in/email", owner);
	assert.equal(r.status, 200, r.text);
});

await check("existing session still works", async () => {
	const r = await call("/get-session", undefined, session);
	assert.equal(r.status, 200);
	assert.match(r.text, /owner@sandbox.test/);
});

await sql.end();
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
