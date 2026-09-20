// SCIM provisioning end to end: users, groups as teams, deactivation as
// suspension, owner protection. Leaves SCIM off.
import assert from "node:assert/strict";
import { base, owner, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const cookie = await signInOwner();
const { check, finish } = runChecks();
const run = Date.now().toString(36);
const connection = `scim-${run}`;
let token = "";

const scim = async (method, path, body, bearer = token) => {
	const res = await fetch(`${base}/api/auth/scim/v2${path}`, {
		method,
		headers: {
			"content-type": "application/scim+json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, json, text };
};

const email = `scim-${run}@sandbox.test`;
let userId = "";
let groupId = "";
const memberRole = async (id) =>
	(
		await sql`select role from member m join organization o on o.id = m.organization_id
			where m.user_id = ${id} limit 1`
	)[0]?.role ?? null;

await check("SCIM endpoints are unreachable while SCIM is off", async () => {
	await trpc("abhashScim.setEnabled", { enabled: false }, cookie);
	const r = await scim("GET", "/Users", undefined, "anything");
	assert.equal(r.status, 404, r.text);
});

await check("owner turns SCIM on and creates a connection token", async () => {
	assert.ok(
		(await trpc("abhashScim.setEnabled", { enabled: true }, cookie)).ok,
	);
	const r = await trpc(
		"abhashScim.createToken",
		{ providerId: connection },
		cookie,
	);
	assert.ok(r.ok, r.error);
	token = r.data.token;
	const [{ scim_token }] =
		await sql`select scim_token from scim_provider where provider_id = ${connection}`;
	assert.ok(!token.includes(scim_token), "token must be stored hashed");
});

await check("requests without a valid token are rejected", async () => {
	assert.equal((await scim("GET", "/Users", undefined, "")).status, 401);
	assert.equal((await scim("GET", "/Groups", undefined, "bad")).status, 401);
});

await check("a group mapping gives SCIM group members a role", async () => {
	const r = await trpc(
		"abhashSso.mappings.create",
		{
			providerId: null,
			groupName: `admins-${run}`,
			orgRole: "admin",
			teamId: null,
			priority: 5,
		},
		cookie,
	);
	assert.ok(r.ok, r.error);
});

await check("creating a user provisions an organization member", async () => {
	const r = await scim("POST", "/Users", {
		schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
		userName: email,
		externalId: `ext-${run}`,
		name: { formatted: "Scim User" },
		emails: [{ value: email, primary: true }],
		active: true,
	});
	assert.equal(r.status, 201, r.text);
	userId = r.json.id;
	assert.equal(await memberRole(userId), "member");
	await sql`insert into session (id, token, user_id, expires_at, created_at, updated_at)
		values (${`s-${run}`}, ${`t-${run}`}, ${userId}, now() + interval '1 hour', now(), now())`;
	await sql`insert into apikey (id, key, reference_id, enabled, created_at, updated_at)
		values (${`k-${run}`}, ${`k-${run}`}, ${userId}, true, now(), now())`;
});

await check(
	"a pushed group becomes a team, and its mapping sets the role",
	async () => {
		const r = await scim("POST", "/Groups", {
			schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
			displayName: `admins-${run}`,
			externalId: `grp-${run}`,
			members: [{ value: userId }],
		});
		assert.equal(r.status, 201, r.text);
		groupId = r.json.id;
		assert.equal(r.json.members[0].value, userId);
		const [team] =
			await sql`select source from abhash_team where id = ${groupId}`;
		assert.equal(team.source, "scim");
		assert.equal(await memberRole(userId), "admin");
	},
);

await check("groups can be found by displayName", async () => {
	const r = await scim(
		"GET",
		`/Groups?filter=${encodeURIComponent(`displayName eq "admins-${run}"`)}`,
	);
	assert.equal(r.status, 200, r.text);
	assert.equal(r.json.totalResults, 1);
});

await check(
	"removing the member from the group drops the mapped role",
	async () => {
		const r = await scim("PATCH", `/Groups/${groupId}`, {
			schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
			Operations: [{ op: "remove", path: `members[value eq "${userId}"]` }],
		});
		assert.equal(r.status, 200, r.text);
		assert.equal(r.json.members.length, 0);
		assert.equal(await memberRole(userId), "member");
	},
);

await check(
	"deactivating suspends: sessions end and API keys stop",
	async () => {
		const r = await scim("PATCH", `/Users/${userId}`, {
			schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
			Operations: [{ op: "replace", path: "active", value: false }],
		});
		assert.ok([200, 204].includes(r.status), r.text);
		const [u] = await sql`select banned from "user" where id = ${userId}`;
		assert.equal(u.banned, true);
		const [{ n }] =
			await sql`select count(*)::int n from session where user_id = ${userId}`;
		assert.equal(n, 0);
		const [key] =
			await sql`select enabled from apikey where id = ${`k-${run}`}`;
		assert.equal(key.enabled, false);
		const [s] =
			await sql`select source from abhash_user_suspension where user_id = ${userId}`;
		assert.equal(s.source, "scim");
	},
);

await check("reactivating restores the user and their key", async () => {
	const r = await scim("PATCH", `/Users/${userId}`, {
		schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
		Operations: [{ op: "replace", path: "active", value: true }],
	});
	assert.ok([200, 204].includes(r.status), r.text);
	const [u] = await sql`select banned from "user" where id = ${userId}`;
	assert.equal(u.banned, false);
	const [key] = await sql`select enabled from apikey where id = ${`k-${run}`}`;
	assert.equal(key.enabled, true);
});

await check("deleting a user suspends instead of removing", async () => {
	const r = await scim("DELETE", `/Users/${userId}`);
	assert.equal(r.status, 204, r.text);
	const [u] = await sql`select banned from "user" where id = ${userId}`;
	assert.equal(u?.banned, true);
	assert.equal(await memberRole(userId), "member");
});

await check(
	"an organization owner can be neither deactivated nor deleted",
	async () => {
		const [o] = await sql`select id from "user" where email = ${owner.email}`;
		const patch = await scim("PATCH", `/Users/${o.id}`, {
			schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
			Operations: [{ op: "replace", path: "active", value: false }],
		});
		assert.equal(patch.status, 400, patch.text);
		const del = await scim("DELETE", `/Users/${o.id}`);
		assert.equal(del.status, 400, del.text);
		const [u] = await sql`select banned from "user" where id = ${o.id}`;
		assert.notEqual(u.banned, true);
	},
);

await check("deleting a group deletes its team", async () => {
	const r = await scim("DELETE", `/Groups/${groupId}`);
	assert.equal(r.status, 204, r.text);
	const [{ n }] =
		await sql`select count(*)::int n from abhash_team where id = ${groupId}`;
	assert.equal(n, 0);
});

await check("a revoked connection's token stops working", async () => {
	assert.ok(
		(await trpc("abhashScim.revoke", { providerId: connection }, cookie)).ok,
	);
	assert.equal((await scim("GET", "/Groups")).status, 401);
});

await trpc("abhashScim.setEnabled", { enabled: false }, cookie);
await finish();
