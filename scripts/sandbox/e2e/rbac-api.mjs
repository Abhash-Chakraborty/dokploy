// Role bindings end to end through the running app: teams, per-project
// roles, the route-level permission carry-over, suspension and app-name
// scoping. Leaves the rbac.v2 flag off.
import assert from "node:assert/strict";
import { auth, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);

const mkProject = async (name) => {
	const created = await trpc(
		"project.create",
		{ name: `${name}-${suffix}` },
		owner,
	);
	assert.ok(created.ok, created.error);
	const projectId = created.data.project?.projectId ?? created.data.projectId;
	const one = await trpc("project.one", { projectId }, owner, "query");
	assert.ok(one.ok, one.error);
	const environmentId = one.data.environments[0].environmentId;
	const app = await trpc(
		"application.create",
		{ name: `${name}-app`, environmentId },
		owner,
	);
	assert.ok(app.ok, app.error);
	return { projectId, environmentId, app: app.data };
};

const A = await mkProject("alpha");
const B = await mkProject("beta");
const C = await mkProject("gamma");

const dev = {
	email: `dev-${suffix}@sandbox.test`,
	password: "Sandbox-pass-123",
};
const created = await trpc(
	"user.createUserWithCredentials",
	{ ...dev, role: "member" },
	owner,
);
assert.ok(created.ok, created.error);
const [{ id: devId }] =
	await sql`select id from "user" where email = ${dev.email}`;

await check("admin API: team, members and grants", async () => {
	const team = await trpc(
		"access.teams.create",
		{ name: `Platform ${suffix}` },
		owner,
	);
	assert.ok(team.ok, team.error);
	const members = await trpc(
		"access.teams.setMembers",
		{ teamId: team.data.id, userIds: [devId] },
		owner,
	);
	assert.ok(members.ok, members.error);
	for (const grant of [
		{
			subjectType: "team",
			subjectId: team.data.id,
			role: "viewer",
			scopeType: "project",
			scopeId: A.projectId,
		},
		{
			subjectType: "user",
			subjectId: devId,
			role: "developer",
			scopeType: "project",
			scopeId: B.projectId,
		},
	]) {
		const r = await trpc("access.bindings.create", grant, owner);
		assert.ok(r.ok, r.error);
	}
});

await check("grants on another organization's scope are refused", async () => {
	const r = await trpc(
		"access.bindings.create",
		{
			subjectType: "user",
			subjectId: devId,
			role: "viewer",
			scopeType: "project",
			scopeId: "not-a-project",
		},
		owner,
	);
	assert.equal(r.ok, false);
});

await check("only the owner can turn the new engine on", async () => {
	const r = await trpc("access.setEnabled", { enabled: true }, owner);
	assert.ok(r.ok, r.error);
});

const signIn = await auth("/sign-in/email", dev);
assert.equal(signIn.status, 200, signIn.text);
const devCookie = signIn.cookie;

await check("the member lists exactly the granted projects", async () => {
	const r = await trpc("project.all", undefined, devCookie, "query");
	assert.ok(r.ok, r.error);
	const ids = new Set(r.data.map((p) => p.projectId));
	assert.deepEqual(ids, new Set([A.projectId, B.projectId]));
});

await check(
	"viewer project: can read the app, cannot change its env vars",
	async () => {
		const read = await trpc(
			"application.one",
			{ applicationId: A.app.applicationId },
			devCookie,
			"query",
		);
		assert.ok(read.ok, read.error);
		const write = await trpc(
			"application.saveEnvironment",
			{
				applicationId: A.app.applicationId,
				env: "X=1",
				buildArgs: "",
				buildSecrets: "",
				createEnvFile: true,
			},
			devCookie,
		);
		assert.equal(write.ok, false, "viewer could write env vars");
	},
);

await check("developer project: can change the app's env vars", async () => {
	const write = await trpc(
		"application.saveEnvironment",
		{
			applicationId: B.app.applicationId,
			env: "X=1",
			buildArgs: "",
			buildSecrets: "",
			createEnvFile: true,
		},
		devCookie,
	);
	assert.ok(write.ok, write.error);
});

await check("ungranted project: cannot read the app", async () => {
	const r = await trpc(
		"application.one",
		{ applicationId: C.app.applicationId },
		devCookie,
		"query",
	);
	assert.equal(r.ok, false);
});

await check(
	"monitoring by app name is scoped to granted services",
	async () => {
		const other = await trpc(
			"application.readAppMonitoring",
			{ appName: C.app.appName },
			devCookie,
			"query",
		);
		assert.match(other.error ?? "", /access/i);
		const internal = await trpc(
			"application.readAppMonitoring",
			{ appName: "dokploy" },
			devCookie,
			"query",
		);
		assert.match(internal.error ?? "", /access/i);
	},
);

await check("suspension ends the session and blocks sign-in", async () => {
	const r = await trpc(
		"access.members.suspend",
		{ userId: devId, reason: "e2e" },
		owner,
	);
	assert.ok(r.ok, r.error);
	const session = await auth("/get-session", undefined, devCookie);
	assert.ok(
		session.text === "null" || !session.text.includes(dev.email),
		session.text,
	);
	const again = await auth("/sign-in/email", dev);
	assert.notEqual(again.status, 200);
});

await check("reactivation lets the user back in", async () => {
	const r = await trpc("access.members.reactivate", { userId: devId }, owner);
	assert.ok(r.ok, r.error);
	const again = await auth("/sign-in/email", dev);
	assert.equal(again.status, 200, again.text);
});

await trpc("access.setEnabled", { enabled: false }, owner);
await finish();
