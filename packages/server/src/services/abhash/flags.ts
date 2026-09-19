import { eq } from "drizzle-orm";
import { db } from "../../db";
import { abhashSettings } from "../../db/schema";

export type AbhashFlag =
	| "rbac.v2"
	| "sso.enabled"
	| "scim.enabled"
	| "jobs.enabled"
	| "vault.enabled";

const TTL_MS = 5_000;

// Next.js bundles every API route separately, so a module-level cache would
// exist once per route and a change made through tRPC would not invalidate
// the auth route's copy. One cache per process, shared through globalThis.
const shared = globalThis as unknown as {
	__abhashSettings?: Map<string, { value: unknown; expiresAt: number }>;
};
shared.__abhashSettings ??= new Map();
const cache = shared.__abhashSettings;

export const getSetting = async <T>(key: string, fallback: T): Promise<T> => {
	const hit = cache.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.value as T;
	const row = await db.query.abhashSettings.findFirst({
		where: eq(abhashSettings.key, key),
	});
	const value = (row?.value as T | undefined) ?? fallback;
	cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
	return value;
};

export const setSetting = async (
	key: string,
	value: unknown,
	updatedBy?: string,
) => {
	await db
		.insert(abhashSettings)
		.values({ key, value, updatedBy })
		.onConflictDoUpdate({
			target: abhashSettings.key,
			set: { value, updatedBy, updatedAt: new Date() },
		});
	cache.delete(key);
};

export const isFlagEnabled = (flag: AbhashFlag) => getSetting(flag, false);
