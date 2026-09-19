import { eq } from "drizzle-orm";
import { db } from "../../db";
import { abhashSettings } from "../../db/schema";

export type AbhashFlag = "rbac.v2" | "sso.enabled" | "scim.enabled";

const TTL_MS = 5_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

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
