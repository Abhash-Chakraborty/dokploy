import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { abhashAgent, abhashApiKeyPolicy } from "../../../db/schema";
import type { Actor } from "./actor";

export type KeyPolicy = typeof abhashApiKeyPolicy.$inferSelect;

const TTL_MS = 10_000;
const shared = globalThis as unknown as {
	__abhashKeyPolicies?: Map<
		string,
		{ value: KeyPolicy | null; expiresAt: number }
	>;
};
shared.__abhashKeyPolicies ??= new Map();

export const forgetKeyPolicy = (keyId?: string) => {
	if (keyId) shared.__abhashKeyPolicies?.delete(keyId);
	else shared.__abhashKeyPolicies?.clear();
};

export const getKeyPolicy = async (keyId: string) => {
	const hit = shared.__abhashKeyPolicies?.get(keyId);
	if (hit && hit.expiresAt > Date.now()) return hit.value;
	const value =
		(await db.query.abhashApiKeyPolicy.findFirst({
			where: eq(abhashApiKeyPolicy.keyId, keyId),
		})) ?? null;
	shared.__abhashKeyPolicies?.set(keyId, {
		value,
		expiresAt: Date.now() + TTL_MS,
	});
	return value;
};

/** `project.*` matches `project.all`; an exact name matches only itself. */
export const matchesPattern = (pattern: string, path: string) =>
	pattern.endsWith("*")
		? path.startsWith(pattern.slice(0, -1))
		: pattern === path;

const ipInCidr = (ip: string, cidr: string) => {
	if (!cidr.includes("/")) return ip === cidr;
	const [range, bitsText] = cidr.split("/");
	const bits = Number(bitsText);
	const toInt = (value: string) =>
		value.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
	if (!range || !/^\d+\.\d+\.\d+\.\d+$/.test(range) || Number.isNaN(bits)) {
		return false;
	}
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (toInt(ip) & mask) === (toInt(range) & mask);
};

export type PolicyDenial = { code: "FORBIDDEN"; message: string };

/**
 * Extra limits a key carries on top of its owner's permissions: read-only,
 * an allow-list of procedures, and an IP allow-list. Returns a denial
 * instead of throwing so the caller can map it to its own error type.
 */
export const checkKeyPolicy = async (
	actor: Actor,
	path: string,
	type: "query" | "mutation" | "subscription",
	ip?: string,
): Promise<PolicyDenial | null> => {
	if (!actor.keyId) return null;
	const policy = await getKeyPolicy(actor.keyId);
	if (actor.type === "agent" && actor.id) {
		const agent = await db.query.abhashAgent.findFirst({
			where: eq(abhashAgent.id, actor.id),
			columns: { enabled: true },
		});
		if (agent && !agent.enabled) {
			return { code: "FORBIDDEN", message: "This agent is paused" };
		}
	}
	if (!policy) return null;
	if (policy.readOnly && type !== "query") {
		return { code: "FORBIDDEN", message: "This key is read-only" };
	}
	if (
		policy.allow.length > 0 &&
		!policy.allow.some((pattern) => matchesPattern(pattern, path))
	) {
		return {
			code: "FORBIDDEN",
			message: `This key may not call ${path}`,
		};
	}
	if (policy.ipAllowList.length > 0) {
		const allowed = ip
			? policy.ipAllowList.some((cidr) => ipInCidr(ip, cidr))
			: false;
		if (!allowed) {
			return {
				code: "FORBIDDEN",
				message: "This key is not allowed from this address",
			};
		}
	}
	return null;
};
