import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
	type AbhashSecretScope,
	abhashSecret,
	abhashSecretUsage,
	abhashSecretVersion,
} from "../../../db/schema";
import { isFlagEnabled } from "../flags";
import { decryptSecretValue, encryptSecretValue, rewrapKey } from "./crypto";
import {
	addRotationKey,
	currentKey,
	keyById,
	keyringIds,
	retireKeys,
} from "./keyring";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SECRET_REF_REGEX = /\$\{\{secret\.([A-Za-z0-9_]+)\}\}/g;
export const MAX_SECRET_BYTES = 64 * 1024;
const KEEP_VERSIONS = 10;

export type SecretRow = typeof abhashSecret.$inferSelect;

const binding = (secretId: string, version: number) => `${secretId}|${version}`;

const assertValue = (value: string) => {
	if (!value) throw new Error("A secret needs a value");
	if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
		throw new Error("Secrets are limited to 64 KB");
	}
};

const storeVersion = async (
	tx: Pick<typeof db, "insert" | "update" | "delete" | "select">,
	secret: Pick<SecretRow, "id" | "currentVersion">,
	value: string,
	userId: string | null,
) => {
	const version = secret.currentVersion + 1;
	const { key } = currentKey();
	await tx.insert(abhashSecretVersion).values({
		secretId: secret.id,
		version,
		createdBy: userId,
		...encryptSecretValue(key, value, binding(secret.id, version)),
	});
	await tx
		.update(abhashSecret)
		.set({
			currentVersion: version,
			updatedBy: userId,
			updatedAt: new Date(),
			valueUpdatedAt: new Date(),
		})
		.where(eq(abhashSecret.id, secret.id));
	await tx
		.delete(abhashSecretVersion)
		.where(
			and(
				eq(abhashSecretVersion.secretId, secret.id),
				lt(abhashSecretVersion.version, version - KEEP_VERSIONS + 1),
			),
		);
	return version;
};

export interface CreateSecretInput {
	organizationId: string;
	name: string;
	description?: string;
	scopeType: AbhashSecretScope;
	scopeId: string;
	tags?: string[];
	value: string;
	expiresAt?: Date | null;
	rotateEveryDays?: number | null;
	userId: string | null;
}

export const createSecret = async (input: CreateSecretInput) => {
	if (!SECRET_NAME.test(input.name)) {
		throw new Error(
			"Use UPPER_SNAKE_CASE: capital letters, digits and underscores, starting with a letter",
		);
	}
	assertValue(input.value);
	return db.transaction(async (tx) => {
		const [secret] = await tx
			.insert(abhashSecret)
			.values({
				organizationId: input.organizationId,
				name: input.name,
				description: input.description ?? "",
				scopeType: input.scopeType,
				scopeId: input.scopeId,
				tags: input.tags ?? [],
				expiresAt: input.expiresAt ?? null,
				rotateEveryDays: input.rotateEveryDays ?? null,
				createdBy: input.userId,
				updatedBy: input.userId,
			})
			.onConflictDoNothing()
			.returning();
		if (!secret) {
			throw new Error(`A secret named ${input.name} already exists here`);
		}
		const version = await storeVersion(tx, secret, input.value, input.userId);
		return { ...secret, currentVersion: version };
	});
};

export const setSecretValue = (
	secret: SecretRow,
	value: string,
	userId: string | null,
) => {
	assertValue(value);
	return db.transaction(async (tx) => {
		// Serialise concurrent writers on the version counter.
		const [locked] = await tx
			.select()
			.from(abhashSecret)
			.where(eq(abhashSecret.id, secret.id))
			.for("update");
		if (!locked) throw new Error("Secret not found");
		return storeVersion(tx, locked, value, userId);
	});
};

const readVersion = async (secretId: string, version: number) => {
	const row = await db.query.abhashSecretVersion.findFirst({
		where: and(
			eq(abhashSecretVersion.secretId, secretId),
			eq(abhashSecretVersion.version, version),
		),
	});
	if (!row) throw new Error("That version no longer exists");
	return decryptSecretValue(
		keyById(row.keyId),
		row,
		binding(secretId, version),
	);
};

export const readSecretValue = (secret: SecretRow, version?: number) =>
	readVersion(secret.id, version ?? secret.currentVersion);

/** Makes an older value current again, as a new version. */
export const restoreSecretVersion = async (
	secret: SecretRow,
	version: number,
	userId: string | null,
) => setSecretValue(secret, await readVersion(secret.id, version), userId);

export const listSecretVersions = (secretId: string) =>
	db.query.abhashSecretVersion.findMany({
		where: eq(abhashSecretVersion.secretId, secretId),
		columns: { version: true, createdAt: true, createdBy: true, keyId: true },
		orderBy: [desc(abhashSecretVersion.version)],
	});

export const secretUsages = (secretId: string) =>
	db.query.abhashSecretUsage.findMany({
		where: eq(abhashSecretUsage.secretId, secretId),
		orderBy: [desc(abhashSecretUsage.lastUsedAt)],
	});

/**
 * New master key; every data key is rewrapped under it and the old keys are
 * dropped only once nothing references them. Values are never decrypted.
 */
export const rotateMasterKey = async () => {
	const previous = keyringIds();
	const next = addRotationKey();
	const nextKey = keyById(next);
	const rows = await db.query.abhashSecretVersion.findMany({
		where: inArray(abhashSecretVersion.keyId, previous),
	});
	for (const row of rows) {
		await db
			.update(abhashSecretVersion)
			.set({
				keyId: next,
				wrappedKey: rewrapKey(
					keyById(row.keyId),
					nextKey,
					row.wrappedKey,
					binding(row.secretId, row.version),
				),
			})
			.where(eq(abhashSecretVersion.id, row.id));
	}
	const stillUsed = await db
		.selectDistinct({ keyId: abhashSecretVersion.keyId })
		.from(abhashSecretVersion);
	retireKeys(stillUsed.map((r) => r.keyId));
	return { keyId: next, rewrapped: rows.length };
};

export type SecretScope = {
	organizationId: string;
	projectId: string;
	environmentId?: string;
};

/**
 * Replaces ${{secret.NAME}} with values. The closest scope wins:
 * environment, then project, then organization.
 */
export const resolveSecretRefs = async (
	text: string | null | undefined,
	scope?: SecretScope,
): Promise<string | null> => {
	if (!text) return text ?? null;
	const names = [
		...new Set([...text.matchAll(SECRET_REF_REGEX)].map((m) => m[1] as string)),
	];
	if (names.length === 0) return text;
	if (!scope) {
		throw new Error("Vault references (${{secret.*}}) are not supported here");
	}
	if (!(await isFlagEnabled("vault.enabled"))) {
		throw new Error(
			"This configuration references the Dokploy vault, which is turned off",
		);
	}
	const scopes = [
		and(
			eq(abhashSecret.scopeType, "organization"),
			eq(abhashSecret.scopeId, scope.organizationId),
		),
		and(
			eq(abhashSecret.scopeType, "project"),
			eq(abhashSecret.scopeId, scope.projectId),
		),
		...(scope.environmentId
			? [
					and(
						eq(abhashSecret.scopeType, "environment"),
						eq(abhashSecret.scopeId, scope.environmentId),
					),
				]
			: []),
	];
	const candidates = await db.query.abhashSecret.findMany({
		where: and(
			eq(abhashSecret.organizationId, scope.organizationId),
			inArray(abhashSecret.name, names),
			or(...scopes),
		),
	});
	const rank = { environment: 0, project: 1, organization: 2 } as const;
	const values = new Map<string, string>();
	const used: SecretRow[] = [];
	for (const name of names) {
		const secret = candidates
			.filter((c) => c.name === name)
			.sort((a, b) => rank[a.scopeType] - rank[b.scopeType])[0];
		if (!secret) {
			throw new Error(
				`Secret ${name} is not in the vault for this project or environment`,
			);
		}
		values.set(name, await readSecretValue(secret));
		used.push(secret);
	}
	await recordUsage(used, scope);
	return text.replace(
		SECRET_REF_REGEX,
		(_m, name: string) => values.get(name) ?? "",
	);
};

const recordUsage = async (secrets: SecretRow[], scope: SecretScope) => {
	if (!scope.environmentId) return;
	const now = new Date();
	const ids = secrets.map((s) => s.id);
	await db
		.update(abhashSecret)
		.set({ lastUsedAt: now })
		.where(inArray(abhashSecret.id, ids));
	await db
		.insert(abhashSecretUsage)
		.values(
			ids.map((secretId) => ({
				secretId,
				projectId: scope.projectId,
				environmentId: scope.environmentId as string,
				lastUsedAt: now,
			})),
		)
		.onConflictDoUpdate({
			target: [abhashSecretUsage.secretId, abhashSecretUsage.environmentId],
			set: { lastUsedAt: sql`excluded.last_used_at` },
		});
};
