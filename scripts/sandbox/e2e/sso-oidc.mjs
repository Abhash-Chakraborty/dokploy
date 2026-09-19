// OIDC single sign-on end to end against the sandbox mock provider
// (`sandbox.sh up --oidc`). Leaves SSO off and unenforced.
import assert from "node:assert/strict";
import {
	auth,
	owner,
	runChecks,
	signInOwner,
	sql,
	ssoLogin,
	trpc,
} from "./lib.mjs";

const issuer = process.env.SANDBOX_OIDC_ISSUER;
assert.ok(issuer, "start the sandbox with --oidc");

const cookie = await signInOwner();
const { check, finish } = runChecks();
const run = Date.now().toString(36);
const providerId = `mock-${run}`;
const email = (name) => `${name}-${run}@sandbox.test`;
const claims = (name, groups) => ({
	sub: `${name}-${run}`,
	email: email(name),
	email_verified: true,
	name,
	groups,
});
const memberOf = async (userEmail) => {
	const [row] = await sql`
		select m.id, m.role from member m join "user" u on u.id = m.user_id
		where u.email = ${userEmail}`;
	return row ?? null;
};
const ssoTeamsOf = async (userEmail) =>
	(
		await sql`
			select t.name from abhash_team_member tm
			join abhash_team t on t.id = tm.team_id
			join "user" u on u.id = tm.user_id
			where u.email = ${userEmail} and tm.source = 'sso'
			order by t.name`
	)
		.map((r) => r.name)
		// Earlier runs leave their own "any provider" mappings in the sandbox.
		.filter((name) => name.endsWith(run));

const provider = {
	providerId,
	displayName: "Mock IdP",
	kind: "generic",
	discoveryUrl: `${issuer}/.well-known/openid-configuration`,
	clientId: "dokploy",
	clientSecret: "sandbox-secret",
	domains: ["sandbox.test"],
	trustForLinking: false,
	jitEnabled: true,
	requireGroupMatch: false,
	defaultRole: "member",
	maxRole: "admin",
};

await check("SSO sign-in is unreachable while SSO is off", async () => {
	await trpc("abhashSso.setEnabled", { enabled: false }, cookie);
	const r = await auth("/sign-in/sso", { providerId: "x", callbackURL: "/" });
	assert.equal(r.status, 404);
});

let teamA;
let admins;
await check("owner sets up a provider, teams and group mappings", async () => {
	for (const r of [
		await trpc("abhashSso.setEnabled", { enabled: true }, cookie),
		await trpc("abhashSso.createProvider", provider, cookie),
	]) {
		assert.ok(r.ok, r.error);
	}
	teamA = (await trpc("access.teams.create", { name: `Team A ${run}` }, cookie))
		.data;
	admins = (
		await trpc("access.teams.create", { name: `Admins ${run}` }, cookie)
	).data;
	for (const m of [
		{
			providerId,
			groupName: "dokploy-admins",
			orgRole: "admin",
			teamId: admins.id,
			priority: 10,
		},
		{
			providerId: null,
			groupName: "dokploy-dev-team-a",
			orgRole: null,
			teamId: teamA.id,
			priority: 0,
		},
	]) {
		const r = await trpc("abhashSso.mappings.create", m, cookie);
		assert.ok(r.ok, r.error);
	}
});

await check("provider secrets never reach the browser", async () => {
	const r = await trpc("abhashSso.providers", undefined, cookie, "query");
	assert.ok(r.ok, r.error);
	assert.ok(!JSON.stringify(r.data).includes("sandbox-secret"));
	assert.equal(
		r.data.find((p) => p.providerId === providerId)?.hasClientSecret,
		true,
	);
});

await check("the sign-in page lists the provider without details", async () => {
	const r = await trpc("abhashSso.publicConfig", undefined, "", "query");
	assert.ok(r.ok, r.error);
	const p = r.data.providers.find((x) => x.providerId === providerId);
	assert.deepEqual(Object.keys(p).sort(), [
		"displayName",
		"kind",
		"providerId",
	]);
});

await check(
	"first sign-in creates the account with team from groups",
	async () => {
		const r = await ssoLogin(providerId, claims("dev", ["dokploy-dev-team-a"]));
		assert.equal(r.email, email("dev"), JSON.stringify(r));
		assert.equal((await memberOf(email("dev")))?.role, "member");
		assert.deepEqual(await ssoTeamsOf(email("dev")), [`Team A ${run}`]);
	},
);

await check("an admin group grants admin and its team", async () => {
	const r = await ssoLogin(
		providerId,
		claims("lead", ["dokploy-admins", "dokploy-dev-team-a"]),
	);
	assert.equal(r.email, email("lead"), JSON.stringify(r));
	assert.equal((await memberOf(email("lead")))?.role, "admin");
	assert.deepEqual(await ssoTeamsOf(email("lead")), [
		`Admins ${run}`,
		`Team A ${run}`,
	]);
});

await check(
	"losing a group in the IdP downgrades at the next sign-in",
	async () => {
		const r = await ssoLogin(
			providerId,
			claims("lead", ["dokploy-dev-team-a"]),
		);
		assert.equal(r.email, email("lead"));
		assert.equal((await memberOf(email("lead")))?.role, "member");
		assert.deepEqual(await ssoTeamsOf(email("lead")), [`Team A ${run}`]);
	},
);

await check("a pinned role is left alone by group sync", async () => {
	const lead = await memberOf(email("lead"));
	await sql`update member set role = 'admin' where id = ${lead.id}`;
	const r = await trpc(
		"access.members.setRolePinned",
		{ memberId: lead.id, pinned: true },
		cookie,
	);
	assert.ok(r.ok, r.error);
	await ssoLogin(providerId, claims("lead", []));
	assert.equal((await memberOf(email("lead")))?.role, "admin");
});

await check("manual team membership survives group sync", async () => {
	const devUser =
		await sql`select id from "user" where email = ${email("dev")}`;
	await sql`insert into abhash_team_member (team_id, user_id, source) values (${admins.id}, ${devUser[0].id}, 'manual')`;
	await ssoLogin(providerId, claims("dev", []));
	const [row] = await sql`
		select count(*)::int n from abhash_team_member
		where team_id = ${admins.id} and user_id = ${devUser[0].id} and source = 'manual'`;
	assert.equal(row.n, 1);
	assert.deepEqual(await ssoTeamsOf(email("dev")), []);
});

await check(
	"with group match required, an unmapped user is refused",
	async () => {
		const r = await trpc(
			"abhashSso.updateProvider",
			{ ...provider, clientSecret: undefined, requireGroupMatch: true },
			cookie,
		);
		assert.ok(r.ok, r.error);
		const login = await ssoLogin(
			providerId,
			claims("outsider", ["some-other-group"]),
		);
		assert.equal(login.email, null, JSON.stringify(login));
		assert.equal(await memberOf(email("outsider")), null);
	},
);

await check(
	"with just-in-time sign-up off, only invited people get in",
	async () => {
		const r = await trpc(
			"abhashSso.updateProvider",
			{ ...provider, clientSecret: undefined, jitEnabled: false },
			cookie,
		);
		assert.ok(r.ok, r.error);
		const login = await ssoLogin(
			providerId,
			claims("stranger", ["dokploy-dev-team-a"]),
		);
		assert.equal(login.email, null, JSON.stringify(login));
		const [{ n }] =
			await sql`select count(*)::int n from "user" where email = ${email("stranger")}`;
		assert.equal(n, 0);
	},
);

await check(
	"an existing password account is not taken over by an untrusted IdP",
	async () => {
		const login = await ssoLogin(providerId, {
			sub: `impersonator-${run}`,
			email: owner.email,
			email_verified: true,
			groups: ["dokploy-admins"],
		});
		assert.equal(login.email, null, JSON.stringify(login));
		const [{ n }] = await sql`
		select count(*)::int n from account a join "user" u on u.id = a.user_id
		where u.email = ${owner.email} and a.provider_id = ${providerId}`;
		assert.equal(n, 0);
	},
);

await check("SSO management endpoints stay unreachable over HTTP", async () => {
	for (const path of [
		"/sso/register",
		"/sso/providers",
		"/sso/update-provider",
	]) {
		const r = await auth(path, {}, cookie);
		assert.equal(r.status, 404, path);
	}
});

await check(
	"enforcing SSO blocks passwords but not the owner's break-glass",
	async () => {
		const r = await trpc(
			"abhashSso.setEnforce",
			{ enabled: true, allowPasskey: false },
			cookie,
		);
		assert.ok(r.ok, r.error);
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		const devPassword = await auth("/sign-in/email", {
			email: email("dev"),
			password: "whatever-123",
		});
		assert.equal(devPassword.status, 403, devPassword.text);
		const social = await auth("/sign-in/social", {
			provider: "github",
			callbackURL: "/",
		});
		assert.equal(social.status, 403);
		const ownerLogin = await auth("/sign-in/email", owner);
		assert.equal(ownerLogin.status, 200, ownerLogin.text);
		const [{ n }] = await sql`
		select count(*)::int n from audit_log
		where resource_name = 'break-glass' and user_email = ${owner.email}`;
		assert.ok(n >= 1);
		const sso = await ssoLogin(
			providerId,
			claims("dev", ["dokploy-dev-team-a"]),
		);
		assert.equal(sso.email, email("dev"));
	},
);

await trpc(
	"abhashSso.setEnforce",
	{ enabled: false, allowPasskey: true },
	cookie,
);
await trpc("abhashSso.setEnabled", { enabled: false }, cookie);
await finish();
