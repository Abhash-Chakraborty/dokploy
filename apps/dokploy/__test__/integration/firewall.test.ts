import { readFileSync } from "node:fs";
import { db } from "@dokploy/server/db";
import {
	abhashServerFirewall,
	abhashServerMeta,
	organization,
	server,
	sshKeys,
	user,
} from "@dokploy/server/db/schema";
import {
	applyFirewall,
	applyScript,
	checkDrift,
	ensureFirewallRow,
	planFirewall,
	render,
} from "@dokploy/server/services/abhash/firewall";
import {
	closeAllConnections,
	collectFacts,
	execPooled,
} from "@dokploy/server/services/abhash/ssh";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fleet = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean)
	.map((entry) => {
		const [name, address] = entry.split("=");
		return { name: name as string, address: address as string };
	});
const keyPath = process.env.SANDBOX_FLEET_KEY;
const live = fleet.length > 0 && keyPath ? describe : describe.skip;

const suffix = nanoid(8);
const organizationId = `fw-${suffix}`;
const ownerId = `${organizationId}-owner`;
let serverId = "";

beforeAll(async () => {
	if (!fleet.length || !keyPath) return;
	await db.insert(user).values({
		id: ownerId,
		email: `${ownerId}@sandbox.test`,
		emailVerified: true,
		expirationDate: new Date().toISOString(),
		createdAt2: new Date().toISOString(),
		updatedAt: new Date(),
	} as never);
	await db.insert(organization).values({
		id: organizationId,
		name: `Firewall ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: `fw-${suffix}`,
			privateKey: readFileSync(keyPath, "utf8"),
			publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
			organizationId,
		})
		.returning();
	const host = fleet[0] as { name: string; address: string };
	const [row] = await db
		.insert(server)
		.values({
			name: `fw-${suffix}`,
			ipAddress: host.address,
			port: 22,
			username: "root",
			appName: `fw-${suffix}`,
			sshKeyId: key?.sshKeyId,
			organizationId,
			serverStatus: "active",
			createdAt: new Date().toISOString(),
		} as never)
		.returning();
	serverId = row?.serverId as string;
	await collectFacts(serverId, organizationId);
});

afterAll(async () => {
	if (serverId) {
		// Leave the sandbox server open again for the other suites.
		await execPooled(
			serverId,
			"ufw --force reset >/dev/null 2>&1; ufw --force disable >/dev/null 2>&1; true",
			{
				timeoutMs: 60_000,
			},
		).catch(() => {});
	}
	closeAllConnections();
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
});

live("firewall against a sandbox server", () => {
	it("refuses to apply while the mode is not enforce", async () => {
		await ensureFirewallRow(serverId, organizationId);
		await expect(
			applyFirewall(serverId, organizationId, () => {}),
		).rejects.toThrow(/off mode|audit/);
	});

	it("derives rules from what is deployed", async () => {
		const plan = await planFirewall(serverId, organizationId);
		const reasons = plan.rules.map((rule) => rule.origin);
		expect(reasons).toContain("auto:ssh");
		expect(reasons).toContain("auto:web");
		expect(plan.lockout).toBeNull();
	});

	it("applies, stays reachable and confirms", async () => {
		await db
			.update(abhashServerFirewall)
			.set({ mode: "enforce" })
			.where(eq(abhashServerFirewall.serverId, serverId));
		const lines: string[] = [];
		const result = await applyFirewall(serverId, organizationId, (line) => {
			lines.push(line);
		});
		expect(result.rules).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("Confirmed");

		const status = await execPooled(serverId, "ufw status verbose", {
			timeoutMs: 30_000,
		});
		expect(status.stdout).toContain("Status: active");
		expect(status.stdout).toContain("deny (incoming)");
		expect(status.stdout).toContain("22/tcp");

		const row = await db.query.abhashServerFirewall.findFirst({
			where: eq(abhashServerFirewall.serverId, serverId),
		});
		expect(row?.appliedHash).toBe(result.hash);
		expect(row?.lastError).toBeNull();
	}, 300_000);

	it("reports no drift right after applying, and drift after a change", async () => {
		const fresh = await checkDrift(serverId, organizationId);
		expect(fresh.drift).toBe(false);

		await execPooled(serverId, "ufw --force disable >/dev/null", {
			timeoutMs: 30_000,
		});
		const changed = await checkDrift(serverId, organizationId);
		expect(changed.drift).toBe(true);
		const row = await db.query.abhashServerFirewall.findFirst({
			where: eq(abhashServerFirewall.serverId, serverId),
		});
		expect(row?.driftedAt).not.toBeNull();
	}, 120_000);

	it("rolls itself back when nobody confirms", async () => {
		// The same script the apply job runs, with a short timer and no
		// confirmation: the server must put its own rules back.
		const rendered = render([
			{
				chain: "input",
				action: "allow",
				protocol: "tcp",
				port: "22",
				from: "any",
				comment: "SSH",
				origin: "auto:ssh",
			},
			{
				chain: "input",
				action: "allow",
				protocol: "tcp",
				port: "9999",
				from: "any",
				comment: "temporary",
				origin: "user:test",
			},
		]);
		await execPooled(
			serverId,
			`sh -s <<'DOKPLOY_APPLY'\n${applyScript(rendered, {
				rollbackSeconds: 5,
				defaultIncoming: "deny",
			})}\nDOKPLOY_APPLY`,
			{ timeoutMs: 120_000 },
		);
		const applied = await execPooled(serverId, "ufw status", {
			timeoutMs: 30_000,
		});
		expect(applied.stdout).toContain("9999");

		await new Promise((resolve) => setTimeout(resolve, 12_000));
		const after = await execPooled(
			serverId,
			"cat /etc/dokploy/abhash/firewall/rollback.log 2>/dev/null; ufw status",
			{ timeoutMs: 30_000 },
		);
		expect(after.stdout).toMatch(/rolled back/);
		expect(after.stdout).not.toContain("9999");
	}, 300_000);
});
