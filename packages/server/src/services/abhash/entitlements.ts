import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { member, organization, organizationRole } from "../../db/schema";

const BUILTIN_DEFAULT_ROLES = new Set(["admin", "member"]);

/**
 * Upstream gates some access-control features (member server and git-provider
 * scoping, custom default roles, a few admin settings) behind a commercial
 * licence. This fork has no licence tiers, so every organization is entitled
 * to all of them.
 */
export const isEntitled = async (_organizationId: string): Promise<boolean> =>
	true;

export const getOrganizationOwnerId = async (
	organizationId: string,
): Promise<string | null> => {
	const owner = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, organizationId),
			eq(member.role, "owner"),
		),
		columns: { userId: true },
	});
	return owner?.userId ?? null;
};

/**
 * The role a newly provisioned member (SCIM, SSO) receives: the
 * organization's configured default when it is a built-in role or an existing
 * custom role, otherwise "member". Never "owner".
 */
export const resolveOrganizationDefaultRole = async (
	organizationId: string,
): Promise<string> => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { defaultRole: true },
	});
	const role = org?.defaultRole;
	if (!role || role === "owner") return "member";
	if (BUILTIN_DEFAULT_ROLES.has(role)) return role;

	const custom = await db.query.organizationRole.findFirst({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, role),
		),
		columns: { id: true },
	});
	return custom ? role : "member";
};
