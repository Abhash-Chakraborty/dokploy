// Members end to end, as each role sees it: adding people (directly and by
// invitation), what admins and members may and may not do to each other,
// locking a role, suspending, removing, and handing ownership over and back.
import assert from "node:assert/strict";
import { auth, base, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36);
const password = "Sandbox-pass-123";
const q = (procedure, input, cookie) => trpc(procedure, input, cookie, "query");

const [{ id: ownerId, organizationId: orgId }] = await sql`
	select u.id, m.organization_id as "organizationId"
	from "user" u join member m on m.user_id = u.id
	where u.email = 'owner@sandbox.test' and m.role = 'owner'`;

const signIn = async (email) => {
	const r = await auth("/sign-in/email", { email, password });
	return r.status === 200 ? r.cookie : null;
};

const addMember = async (label, role) => {
	// Mixed case on purpose: the address must come back exactly as typed.
	const email = `${label}-${suffix}@Sandbox.test`.replace("@S", "@s");
	const created = await trpc(
		"user.createUserWithCredentials",
		{ email, password, role },
		owner,
	);
	assert.ok(created.ok, created.error);
	const [row] = await sql`
		select m.id as "memberId", u.id as "userId" from member m
		join "user" u on u.id = m.user_id
		where u.email = ${email.toLowerCase()} and m.organization_id = ${orgId}`;
	assert.ok(row, `${label} was not added to the organization`);
	return { email: email.toLowerCase(), ...row, cookie: await signIn(email) };
};

const admin = await addMember("admin", "admin");
const admin2 = await addMember("admin2", "admin");
const dev = await addMember("dev", "member");
const dev2 = await addMember("dev2", "member");
const created = [admin, admin2, dev, dev2];

const memberRow = async (memberId) => {
	const list = await q("access.members.list", null, owner);
	assert.ok(list.ok, list.error);
	return list.data.find((m) => m.memberId === memberId);
};

try {
	await check("new members can sign in and see their role", async () => {
		for (const person of created) assert.ok(person.cookie, person.email);
		const me = await q("user.get", null, dev.cookie);
		assert.ok(me.ok, me.error);
		assert.equal(me.data.role, "member");
		const adminMe = await q("user.get", null, admin.cookie);
		assert.equal(adminMe.data.role, "admin");
	});

	await check("the member list shows everyone with their role", async () => {
		const row = await memberRow(dev.memberId);
		assert.equal(row.role, "member");
		assert.equal(row.user.email, dev.email);
		assert.equal((await memberRow(admin.memberId)).role, "admin");
	});

	await check("an invited person signs up and joins", async () => {
		const email = `invitee-${suffix}@sandbox.test`;
		const invite = await trpc(
			"organization.inviteMember",
			{ email, role: "member" },
			admin.cookie,
		);
		assert.ok(invite.ok, invite.error);
		const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: base,
				"x-dokploy-token": invite.data.id,
			},
			body: JSON.stringify({ email, password, name: "Invitee", lastName: "" }),
		});
		assert.equal(signUp.status, 200, await signUp.text());
		const cookie = (signUp.headers.getSetCookie?.() ?? [])
			.map((c) => c.split(";")[0])
			.join("; ");
		const accepted = await auth(
			"/organization/accept-invitation",
			{ invitationId: invite.data.id },
			cookie,
		);
		assert.equal(accepted.status, 200, accepted.text);
		const [row] = await sql`
			select m.id as "memberId", u.id as "userId", m.role from member m
			join "user" u on u.id = m.user_id
			where u.email = ${email} and m.organization_id = ${orgId}`;
		assert.equal(row?.role, "member");
		created.push({ email, ...row, cookie });
	});

	await check("a member cannot manage other members", async () => {
		for (const [procedure, input] of [
			["access.members.remove", { memberId: dev2.memberId }],
			["access.members.suspend", { userId: dev2.userId }],
			["access.members.transferOwnership", { memberId: dev2.memberId }],
			[
				"organization.inviteMember",
				{ email: `x-${suffix}@sandbox.test`, role: "member" },
			],
		]) {
			const r = await trpc(procedure, input, dev.cookie);
			assert.equal(r.ok, false, `${procedure} should be refused`);
		}
		assert.ok(await memberRow(dev2.memberId));
	});

	await check(
		"an admin cannot act on the owner, themselves or another admin",
		async () => {
			const [ownerMember] =
				await sql`select id from member where user_id = ${ownerId} and organization_id = ${orgId}`;
			for (const [procedure, input] of [
				["access.members.remove", { memberId: ownerMember.id }],
				["access.members.suspend", { userId: ownerId }],
				["access.members.remove", { memberId: admin.memberId }],
				["access.members.suspend", { userId: admin.userId }],
				["access.members.remove", { memberId: admin2.memberId }],
				["access.members.suspend", { userId: admin2.userId }],
				["access.members.transferOwnership", { memberId: dev.memberId }],
			]) {
				const r = await trpc(procedure, input, admin.cookie);
				assert.equal(
					r.ok,
					false,
					`${procedure} ${JSON.stringify(input)} should be refused`,
				);
			}
		},
	);

	await check(
		"nobody can act on a member of another organization",
		async () => {
			const [other] = await sql`
			select m.user_id as "userId", m.id as "memberId" from member m
			where m.organization_id <> ${orgId} limit 1`;
			if (!other) return;
			const r = await trpc(
				"access.members.suspend",
				{ userId: other.userId },
				owner,
			);
			assert.equal(r.ok, false);
			const removed = await trpc(
				"access.members.remove",
				{ memberId: other.memberId },
				owner,
			);
			assert.equal(removed.ok, false);
		},
	);

	await check("an admin can lock and unlock a member's role", async () => {
		const lock = await trpc(
			"access.members.setRolePinned",
			{ memberId: dev.memberId, pinned: true },
			admin.cookie,
		);
		assert.ok(lock.ok, lock.error);
		assert.equal((await memberRow(dev.memberId)).rolePinned, true);
		await trpc(
			"access.members.setRolePinned",
			{ memberId: dev.memberId, pinned: false },
			admin.cookie,
		);
		assert.equal((await memberRow(dev.memberId)).rolePinned, false);
	});

	await check(
		"a suspended member cannot sign in until reactivated",
		async () => {
			const suspended = await trpc(
				"access.members.suspend",
				{ userId: dev2.userId },
				admin.cookie,
			);
			assert.ok(suspended.ok, suspended.error);
			assert.equal(await signIn(dev2.email), null);
			const back = await trpc(
				"access.members.reactivate",
				{ userId: dev2.userId },
				admin.cookie,
			);
			assert.ok(back.ok, back.error);
			dev2.cookie = await signIn(dev2.email);
			assert.ok(dev2.cookie);
		},
	);

	await check("an admin removes a member, who then loses access", async () => {
		const before = await q("project.all", null, dev2.cookie);
		assert.ok(before.ok, before.error);
		const r = await trpc(
			"access.members.remove",
			{ memberId: dev2.memberId },
			admin.cookie,
		);
		assert.ok(r.ok, r.error);
		assert.equal(await memberRow(dev2.memberId), undefined);
		const projects = await q("project.all", null, dev2.cookie);
		assert.equal(
			projects.ok,
			false,
			"a removed member still reached the organization",
		);
	});

	await check("only the owner removes an admin", async () => {
		const r = await trpc(
			"access.members.remove",
			{ memberId: admin2.memberId },
			owner,
		);
		assert.ok(r.ok, r.error);
		assert.equal(await memberRow(admin2.memberId), undefined);
	});

	await check("the owner hands ownership over, and gets it back", async () => {
		const [ownerMember] =
			await sql`select id from member where user_id = ${ownerId} and organization_id = ${orgId}`;
		const handed = await trpc(
			"access.members.transferOwnership",
			{ memberId: admin.memberId },
			owner,
		);
		assert.ok(handed.ok, handed.error);
		const [org] =
			await sql`select owner_id from organization where id = ${orgId}`;
		assert.equal(org.owner_id, admin.userId);
		assert.equal((await memberRow(admin.memberId)).role, "owner");
		assert.equal((await memberRow(ownerMember.id)).role, "admin");

		// The old owner is an admin now and cannot take it back themselves.
		const grab = await trpc(
			"access.members.transferOwnership",
			{ memberId: ownerMember.id },
			await signIn("owner@sandbox.test"),
		);
		assert.equal(grab.ok, false);

		const back = await trpc(
			"access.members.transferOwnership",
			{ memberId: ownerMember.id },
			await signIn(admin.email),
		);
		assert.ok(back.ok, back.error);
		const [after] =
			await sql`select owner_id from organization where id = ${orgId}`;
		assert.equal(after.owner_id, ownerId);
		assert.equal((await memberRow(admin.memberId)).role, "admin");
	});
} finally {
	// Leave the sandbox owned by owner@sandbox.test whatever happened above.
	await sql`update organization set owner_id = ${ownerId} where id = ${orgId}`;
	await sql`update member set role = 'owner' where user_id = ${ownerId} and organization_id = ${orgId}`;
	for (const person of created) {
		await sql`delete from "user" where id = ${person.userId}`;
	}
}

await finish();
