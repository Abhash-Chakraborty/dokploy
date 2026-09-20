import { readFileSync } from "node:fs";
import { db } from "@dokploy/server/db";
import {
	abhashServerMeta,
	organization,
	server,
	sshKeys,
	user,
} from "@dokploy/server/db/schema";
import {
	closeAllConnections,
	collectFacts,
	execPooled,
	HostKeyMismatchError,
	healthFromFacts,
	parseFacts,
	poolSize,
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
const organizationId = `fleet-${suffix}`;
const ownerId = `${organizationId}-owner`;
const serverIds: string[] = [];

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
		name: `Fleet ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: `fleet-${suffix}`,
			privateKey: readFileSync(keyPath, "utf8"),
			publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
			organizationId,
		})
		.returning();
	for (const host of fleet) {
		const [row] = await db
			.insert(server)
			.values({
				name: host.name,
				ipAddress: host.address,
				port: 22,
				username: "root",
				appName: `${host.name}-${suffix}`,
				sshKeyId: key?.sshKeyId,
				organizationId,
				serverStatus: "active",
				createdAt: new Date().toISOString(),
			} as never)
			.returning();
		if (row) serverIds.push(row.serverId);
	}
});

afterAll(async () => {
	closeAllConnections();
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
});

describe("fact parsing", () => {
	it("reads the one-shot script's output", () => {
		const facts = parseFacts(
			[
				"os=Ubuntu 24.04 LTS",
				"kernel=6.8.0",
				"cores=4",
				"memory_mb=7800",
				"disk_pct=42",
				"load1=0.35",
				"uptime=1200",
				"docker=28.5.0",
				"swarm=active",
			].join("\n"),
		);
		expect(facts).toMatchObject({
			os: "Ubuntu 24.04 LTS",
			cpuCores: 4,
			diskUsedPercent: 42,
			dockerVersion: "28.5.0",
			swarm: "active",
		});
	});

	it("calls a nearly full disk degraded, not offline", () => {
		expect(healthFromFacts({ diskUsedPercent: 95 })).toMatchObject({
			health: "degraded",
		});
		expect(
			healthFromFacts({ diskUsedPercent: 10, swarm: "active" }),
		).toMatchObject({ health: "online" });
	});
});

live("pooled SSH against the sandbox fleet", () => {
	it("runs a command and returns its exit code", async () => {
		const id = serverIds[0] as string;
		const ok = await execPooled(id, "echo hello");
		expect(ok.stdout.trim()).toBe("hello");
		expect(ok.exitCode).toBe(0);
		const bad = await execPooled(id, "exit 3");
		expect(bad.exitCode).toBe(3);
	});

	it("reuses one connection for many commands", async () => {
		const id = serverIds[0] as string;
		await Promise.all(
			Array.from({ length: 12 }, (_, index) => execPooled(id, `echo ${index}`)),
		);
		expect(poolSize()).toBeLessThanOrEqual(serverIds.length);
	});

	it("times out instead of hanging", async () => {
		await expect(
			execPooled(serverIds[0] as string, "sleep 30", { timeoutMs: 1_000 }),
		).rejects.toThrow(/Timed out/);
	});

	it("can be cancelled", async () => {
		const controller = new AbortController();
		const running = execPooled(serverIds[0] as string, "sleep 30", {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 200);
		await expect(running).rejects.toThrow(/Cancelled/);
	});

	it("pins the host key on first use and refuses a changed one", async () => {
		const id = serverIds[1] as string;
		await collectFacts(id, organizationId);
		const pinned = await db.query.abhashServerMeta.findFirst({
			where: eq(abhashServerMeta.serverId, id),
		});
		expect(pinned?.hostKey).toMatch(/^SHA256:/);
		expect(pinned?.health).toBe("online");
		expect(pinned?.facts?.os).toContain("Ubuntu");

		closeAllConnections();
		await db
			.update(abhashServerMeta)
			.set({ hostKey: "SHA256:not-the-real-key" })
			.where(eq(abhashServerMeta.serverId, id));
		await expect(execPooled(id, "echo nope")).rejects.toThrow(
			HostKeyMismatchError,
		);
		const flagged = await db.query.abhashServerMeta.findFirst({
			where: eq(abhashServerMeta.serverId, id),
		});
		expect(flagged?.hostKeyMismatch).toBe(true);

		// Accepting the new key is what an admin does from the UI.
		await db
			.update(abhashServerMeta)
			.set({ hostKey: null, hostKeyMismatch: false })
			.where(eq(abhashServerMeta.serverId, id));
		closeAllConnections();
		const recovered = await execPooled(id, "echo back");
		expect(recovered.stdout.trim()).toBe("back");
	});

	it("records a server it cannot reach as offline", async () => {
		const [row] = await db
			.insert(server)
			.values({
				name: `gone-${suffix}`,
				ipAddress: "127.0.0.9",
				port: 22,
				username: "root",
				appName: `gone-${suffix}`,
				sshKeyId: (
					await db.query.sshKeys.findFirst({
						where: eq(sshKeys.organizationId, organizationId),
					})
				)?.sshKeyId,
				organizationId,
				serverStatus: "active",
				createdAt: new Date().toISOString(),
			} as never)
			.returning();
		const result = await collectFacts(row!.serverId, organizationId);
		expect(result.health).toBe("offline");
	}, 60_000);
});
