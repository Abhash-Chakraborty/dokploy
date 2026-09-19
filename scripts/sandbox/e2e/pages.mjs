// Every fork page must render for the owner: this catches a router or
// component mistake that only shows up at runtime.
import assert from "node:assert/strict";
import { base, runChecks, signInOwner } from "./lib.mjs";

const cookie = await signInOwner();
const { check, finish } = runChecks();

const PAGES = [
	"/dashboard/command-center",
	"/dashboard/settings/vault",
	"/dashboard/settings/agents",
	"/dashboard/settings/ansible",
	"/dashboard/settings/secure-network",
	"/dashboard/settings/firewall",
	"/dashboard/settings/backup-health",
	"/dashboard/settings/engines",
	"/dashboard/settings/authentication",
	"/dashboard/settings/audit-logs",
	"/dashboard/settings/servers",
];

for (const path of PAGES) {
	await check(`${path} renders`, async () => {
		const response = await fetch(`${base}${path}`, {
			headers: { cookie },
			redirect: "manual",
		});
		assert.ok(
			[200, 304].includes(response.status),
			`status ${response.status}`,
		);
		const html = await response.text();
		assert.ok(
			!/Application error|Internal Server Error/i.test(html),
			"the page rendered an error",
		);
	});
}

await finish();
