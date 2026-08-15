import { db } from "@dokploy/server/db";
import {
	organization,
	organizationRole,
	user,
} from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";

// Inlined here — this fork drops the SSO module that upstream exports it from.
const getOrganizationOwnerId = async (organizationId: string) => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { ownerId: true },
	});
	if (!org) return null;
	return org.ownerId;
};

export const hasValidLicense = async (organizationId: string) => {
	const ownerId = await getOrganizationOwnerId(organizationId);

	if (!ownerId) {
		return false;
	}

	const currentUser = await db.query.user.findFirst({
		where: eq(user.id, ownerId),
		columns: {
			enableEnterpriseFeatures: true,
			isValidEnterpriseLicense: true,
		},
	});
	return !!(
		currentUser?.enableEnterpriseFeatures &&
		currentUser?.isValidEnterpriseLicense
	);
};

export const resolveOrganizationDefaultRole = async (
	organizationId: string,
) => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { defaultRole: true },
	});
	const defaultRole = org?.defaultRole;

	if (!defaultRole || defaultRole === "owner") {
		return "member";
	}

	if (defaultRole === "admin" || defaultRole === "member") {
		return defaultRole;
	}

	const customRole = await db.query.organizationRole.findFirst({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, defaultRole),
		),
		columns: { id: true },
	});

	if (!customRole || !(await hasValidLicense(organizationId))) {
		return "member";
	}

	return defaultRole;
};
