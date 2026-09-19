// Shared helpers for sandbox e2e scripts. Run them through
//   scripts/sandbox/sandbox.sh exec -- node scripts/sandbox/e2e/<script>.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const appRequire = createRequire(
	new URL("../../../apps/dokploy/package.json", import.meta.url),
);
const { default: postgres } = await import(appRequire.resolve("postgres"));

export const base = process.env.BETTER_AUTH_URL;
const dbUrl = process.env.SANDBOX_DATABASE_URL;
assert.ok(base?.startsWith("http://127.0.0.1:"), "run through sandbox.sh exec");
assert.ok(dbUrl?.includes("@127.0.0.1:"), "run through sandbox.sh exec");

export const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
export const owner = {
	email: "owner@sandbox.test",
	password: "Sandbox-pass-123",
};

export const auth = async (path, body, cookie) => {
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
	return {
		status: res.status,
		text: await res.text(),
		cookie: (res.headers.getSetCookie?.() ?? [])
			.map((c) => c.split(";")[0])
			.join("; "),
	};
};

/** Calls a tRPC procedure; returns { ok, data, error }. */
export const trpc = async (procedure, input, cookie, kind = "mutation") => {
	const url =
		kind === "query"
			? `${base}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`
			: `${base}/api/trpc/${procedure}`;
	const res = await fetch(url, {
		method: kind === "query" ? "GET" : "POST",
		headers: { "content-type": "application/json", origin: base, cookie },
		body:
			kind === "query" ? undefined : JSON.stringify({ json: input ?? null }),
	});
	const body = await res.json().catch(() => ({}));
	return body.error
		? { ok: false, status: res.status, error: body.error.json?.message ?? "" }
		: { ok: true, data: body.result?.data?.json };
};

export const signInOwner = async () => {
	const [{ n }] =
		await sql`select count(*)::int n from member where role = 'owner'`;
	if (n === 0) {
		const r = await auth("/sign-up/email", { ...owner, name: "Owner" });
		assert.equal(r.status, 200, r.text);
	}
	const r = await auth("/sign-in/email", owner);
	assert.equal(r.status, 200, r.text);
	return r.cookie;
};

export const runChecks = () => {
	const results = [];
	const check = async (name, fn) => {
		try {
			await fn();
			results.push(`ok   ${name}`);
		} catch (e) {
			results.push(`FAIL ${name}: ${e.message}`);
		}
	};
	const finish = async () => {
		await sql.end();
		console.log(results.join("\n"));
		if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
	};
	return { check, finish };
};
