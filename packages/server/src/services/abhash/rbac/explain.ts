import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { member } from "../../../db/schema";
import { statements } from "../../../lib/access-control";
import { loadRole, ORG_ROLE, roleGrants, SCOPED_RESOURCES } from "./roles";
import {
	ancestry,
	applicableBindings,
	bindingsFor,
	type ScopeRef,
} from "./scope";

/**
 * What a member can do at a scope, and which bindings grant it. Powers the
 * admin "effective access" view; authorization itself goes through the
 * resolver.
 */
export const explainAccess = async (
	userId: string,
	organizationId: string,
	target: ScopeRef,
) => {
	const row = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
	});
	if (!row) return null;
	const privileged = row.role === "owner" || row.role === "admin";
	const chain = await ancestry(target);
	const applicable = privileged
		? []
		: applicableBindings(await bindingsFor(userId, organizationId), chain);

	const grants: Record<string, { action: string; via: string[] }[]> = {};
	const roleCache = new Map<string, Awaited<ReturnType<typeof loadRole>>>();
	const role = async (name: string) => {
		const resolved = name === ORG_ROLE ? row.role : name;
		if (!roleCache.has(resolved)) {
			roleCache.set(resolved, await loadRole(resolved, organizationId));
		}
		return roleCache.get(resolved) ?? null;
	};

	for (const [resource, actions] of Object.entries(statements)) {
		if (!SCOPED_RESOURCES.has(resource)) continue;
		for (const action of actions) {
			const via: string[] = [];
			if (privileged) {
				via.push(`organization role: ${row.role}`);
			} else {
				for (const b of applicable) {
					const r = await role(b.role);
					if (r && roleGrants(r, resource, action)) {
						const who = b.subjectType === "team" ? "team" : "direct";
						const name =
							b.role === ORG_ROLE ? `${row.role} (org role)` : b.role;
						via.push(
							`${who} ${name} on ${b.scopeType}${b.inherit ? "" : " (this item only)"}`,
						);
					}
				}
			}
			if (via.length) {
				grants[resource] ??= [];
				grants[resource].push({ action, via });
			}
		}
	}
	return {
		role: row.role,
		privileged,
		chain,
		bindings: applicable,
		grants,
	};
};
