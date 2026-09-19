import { db } from "@dokploy/server/db";
import {
	abhashSecret,
	environments,
	organization,
	projects,
	sshKeys,
	user,
} from "@dokploy/server/db/schema";
import { setSetting } from "@dokploy/server/services/abhash/flags";
import {
	createKeyring,
	createSecret,
	keyringIds,
	readSecretValue,
	resolveSecretRefs,
	restoreSecretVersion,
	rotateMasterKey,
	setCredentialEncryptionEnabled,
	setSecretValue,
} from "@dokploy/server/services/abhash/vault";
import { resolveVaultReferences } from "@dokploy/server/utils/vault";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suffix = nanoid(8);
const organizationId = `vault-${suffix}`;
const ownerId = `${organizationId}-owner`;
let projectId = "";
let environmentId = "";
let otherProjectId = "";

beforeAll(async () => {
	createKeyring();
	await setSetting("vault.enabled", true);
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
		name: `Vault ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [project] = await db
		.insert(projects)
		.values({ name: `p-${suffix}`, organizationId })
		.returning();
	projectId = project?.projectId as string;
	const [other] = await db
		.insert(projects)
		.values({ name: `o-${suffix}`, organizationId })
		.returning();
	otherProjectId = other?.projectId as string;
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId })
		.returning();
	environmentId = environment?.environmentId as string;
});

afterAll(async () => {
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
	await setSetting("vault.enabled", false);
});

const scope = () => ({ organizationId, projectId, environmentId });

describe("vault secrets", () => {
	it("stores a value that never appears in the row", async () => {
		const secret = await createSecret({
			organizationId,
			name: "API_KEY",
			scopeType: "organization",
			scopeId: organizationId,
			value: "top-secret-value",
			userId: ownerId,
		});
		const row = await db.query.abhashSecret.findFirst({
			where: eq(abhashSecret.id, secret.id),
		});
		expect(JSON.stringify(row)).not.toContain("top-secret-value");
		expect(await readSecretValue(secret)).toBe("top-secret-value");
	});

	it("refuses a duplicate name in the same scope", async () => {
		await expect(
			createSecret({
				organizationId,
				name: "API_KEY",
				scopeType: "organization",
				scopeId: organizationId,
				value: "x",
				userId: ownerId,
			}),
		).rejects.toThrow(/already exists/);
	});

	it("keeps versions and can restore an older one", async () => {
		const secret = await createSecret({
			organizationId,
			name: "ROTATING",
			scopeType: "project",
			scopeId: projectId,
			value: "v1-value",
			userId: ownerId,
		});
		await setSecretValue(secret, "v2-value", ownerId);
		const current = async () =>
			readSecretValue(
				(await db.query.abhashSecret.findFirst({
					where: eq(abhashSecret.id, secret.id),
				}))!,
			);
		expect(await current()).toBe("v2-value");
		await restoreSecretVersion(
			(await db.query.abhashSecret.findFirst({
				where: eq(abhashSecret.id, secret.id),
			}))!,
			1,
			ownerId,
		);
		expect(await current()).toBe("v1-value");
	});

	it("resolves references, closest scope first", async () => {
		await createSecret({
			organizationId,
			name: "TOKEN",
			scopeType: "organization",
			scopeId: organizationId,
			value: "org-token",
			userId: ownerId,
		});
		expect(await resolveSecretRefs("T=${{secret.TOKEN}}", scope())).toBe(
			"T=org-token",
		);
		await createSecret({
			organizationId,
			name: "TOKEN",
			scopeType: "environment",
			scopeId: environmentId,
			value: "env-token",
			userId: ownerId,
		});
		expect(await resolveSecretRefs("T=${{secret.TOKEN}}", scope())).toBe(
			"T=env-token",
		);
	});

	it("does not leak a project's secret into another project", async () => {
		await createSecret({
			organizationId,
			name: "ONLY_HERE",
			scopeType: "project",
			scopeId: projectId,
			value: "scoped",
			userId: ownerId,
		});
		await expect(
			resolveSecretRefs("X=${{secret.ONLY_HERE}}", {
				organizationId,
				projectId: otherProjectId,
			}),
		).rejects.toThrow(/not in the vault/);
	});

	it("records where a secret was used", async () => {
		await resolveSecretRefs("X=${{secret.API_KEY}}", scope());
		const usage = await db.query.abhashSecretUsage.findMany();
		expect(usage.some((u) => u.environmentId === environmentId)).toBe(true);
	});

	it("resolves through the deploy-time vault resolver", async () => {
		expect(await resolveVaultReferences("A=${{secret.API_KEY}}", scope())).toBe(
			"A=top-secret-value",
		);
	});

	it("fails loudly when the vault is off", async () => {
		await setSetting("vault.enabled", false);
		await expect(
			resolveSecretRefs("A=${{secret.API_KEY}}", scope()),
		).rejects.toThrow(/turned off/);
		await setSetting("vault.enabled", true);
	});

	it("rotates the master key without decrypting values", async () => {
		const before = keyringIds();
		const result = await rotateMasterKey();
		expect(result.rewrapped).toBeGreaterThan(0);
		expect(keyringIds()).not.toEqual(before);
		const secret = await db.query.abhashSecret.findFirst({
			where: eq(abhashSecret.organizationId, organizationId),
		});
		expect(await readSecretValue(secret!)).toBeTruthy();
		expect(await resolveSecretRefs("A=${{secret.API_KEY}}", scope())).toBe(
			"A=top-secret-value",
		);
	});
});

describe("credential encryption", () => {
	it("encrypts stored credentials and reads them back, both ways", async () => {
		const [key] = await db
			.insert(sshKeys)
			.values({
				name: `key-${suffix}`,
				privateKey: "-----BEGIN PRIVATE KEY-----\nsandbox\n",
				publicKey: "ssh-ed25519 AAAA sandbox",
				organizationId,
			})
			.returning();
		const sshKeyId = key?.sshKeyId as string;
		const raw = async () => {
			const rows = await db.execute<{ privateKey: string }>(
				sql`SELECT "privateKey" FROM "ssh-key" WHERE "sshKeyId" = ${sshKeyId}`,
			);
			return rows[0]?.privateKey ?? "";
		};
		const viaDrizzle = async () =>
			(
				await db.query.sshKeys.findFirst({
					where: eq(sshKeys.sshKeyId, sshKeyId),
				})
			)?.privateKey;

		expect(await raw()).toContain("BEGIN PRIVATE KEY");

		await setCredentialEncryptionEnabled(true, ownerId);
		expect(await raw()).toMatch(/^enc:v1:/);
		expect(await viaDrizzle()).toContain("BEGIN PRIVATE KEY");

		// A value written while encryption is on is stored encrypted.
		await db
			.update(sshKeys)
			.set({ privateKey: "-----BEGIN PRIVATE KEY-----\nrotated\n" })
			.where(eq(sshKeys.sshKeyId, sshKeyId));
		expect(await raw()).toMatch(/^enc:v1:/);
		expect(await viaDrizzle()).toContain("rotated");

		// Turning it off converts back, so the previous image still works.
		await setCredentialEncryptionEnabled(false, ownerId);
		expect(await raw()).toContain("BEGIN PRIVATE KEY");
		expect(await viaDrizzle()).toContain("rotated");

		await db.delete(sshKeys).where(eq(sshKeys.sshKeyId, sshKeyId));
	});
});
