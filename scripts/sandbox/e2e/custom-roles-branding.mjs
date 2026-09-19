import assert from "node:assert/strict";
import { base, runChecks, signInOwner, sql, trpc } from "./lib.mjs";

const cookie = await signInOwner();
const { check, finish } = runChecks();

await check("create a custom role", async () => {
	const r = await trpc(
		"customRole.create",
		{
			roleName: "release-manager",
			permissions: { deployment: ["read", "create"], logs: ["read"] },
		},
		cookie,
	);
	assert.ok(r.ok, r.error);
});

await check(
	"reserved and non-assignable names/resources are rejected",
	async () => {
		for (const input of [
			{ roleName: "viewer", permissions: {} },
			{ roleName: "x1", permissions: { organization: ["delete"] } },
			{ roleName: "x2", permissions: { deployment: ["destroy"] } },
		]) {
			const r = await trpc("customRole.create", input, cookie);
			assert.equal(r.ok, false, `accepted ${JSON.stringify(input)}`);
		}
	},
);

await check("list shows the role with merged permissions", async () => {
	const r = await trpc("customRole.all", undefined, cookie, "query");
	assert.ok(r.ok, r.error);
	const role = r.data.find((x) => x.role === "release-manager");
	assert.deepEqual(role.permissions, {
		deployment: ["create", "read"],
		logs: ["read"],
	});
});

await check(
	"rename carries members and the org default role along",
	async () => {
		await sql`update organization set default_role = 'release-manager'`;
		const r = await trpc(
			"customRole.update",
			{
				roleName: "release-manager",
				newRoleName: "releaser",
				permissions: { deployment: ["read"] },
			},
			cookie,
		);
		assert.ok(r.ok, r.error);
		const [{ defaultRole }] =
			await sql`select default_role as "defaultRole" from organization limit 1`;
		assert.equal(defaultRole, "releaser");
	},
);

await check("the org default role cannot be deleted", async () => {
	const r = await trpc("customRole.remove", { roleName: "releaser" }, cookie);
	assert.equal(r.ok, false);
});

await check("delete works once it is no longer the default", async () => {
	await sql`update organization set default_role = 'member'`;
	const r = await trpc("customRole.remove", { roleName: "releaser" }, cookie);
	assert.ok(r.ok, r.error);
	const [{ n }] = await sql`select count(*)::int n from organization_role`;
	assert.equal(n, 0);
});

await check(
	"branding is saved and served in the SSR document without a licence",
	async () => {
		const config = {
			appName: "Acme Deploy",
			appDescription: null,
			logoUrl: null,
			faviconUrl: null,
			customCss: null,
			loginLogoUrl: null,
			supportUrl: null,
			docsUrl: null,
			errorPageTitle: null,
			errorPageDescription: null,
			footerText: null,
			ogImageUrl: null,
		};
		const r = await trpc(
			"whitelabeling.update",
			{ whitelabelingConfig: config },
			cookie,
		);
		assert.ok(r.ok, r.error);
		const html = await (await fetch(`${base}/`)).text();
		assert.match(html, /<title>Acme Deploy<\/title>/);
	},
);

await check("branding reset restores the default title", async () => {
	const r = await trpc("whitelabeling.reset", undefined, cookie);
	assert.ok(r.ok, r.error);
	const html = await (await fetch(`${base}/`)).text();
	assert.match(html, /<title>Dokploy<\/title>/);
});

await finish();
