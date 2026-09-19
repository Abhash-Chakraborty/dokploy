import { APIError } from "better-auth/api";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashMemberMeta,
	abhashSsoGroupMapping,
	abhashSsoProvider,
	abhashTeam,
	abhashTeamMember,
	invitation,
	member,
	organizationRole,
	ssoProvider,
} from "../../../db/schema";
import { createAuditLog } from "../audit-log";
import { isFlagEnabled } from "../flags";

const deny = (message: string) => new APIError("FORBIDDEN", { message });

const loadProvider = async (providerId: string) => {
	const [provider, settings] = await Promise.all([
		db.query.ssoProvider.findFirst({
			where: eq(ssoProvider.providerId, providerId),
		}),
		db.query.abhashSsoProvider.findFirst({
			where: eq(abhashSsoProvider.providerId, providerId),
		}),
	]);
	if (!provider?.organizationId || !settings) return null;
	return { ...settings, organizationId: provider.organizationId };
};

const pendingInvitation = (email: string, organizationId: string) =>
	db.query.invitation.findFirst({
		where: and(
			sql`lower(${invitation.email}) = ${email.toLowerCase()}`,
			eq(invitation.organizationId, organizationId),
			eq(invitation.status, "pending"),
			gt(invitation.expiresAt, new Date()),
		),
	});

/** A role name that is safe to assign: never owner, and custom roles must exist. */
const safeRole = async (
	role: string | null | undefined,
	organizationId: string,
) => {
	if (!role || role === "owner") return "member";
	if (role === "admin" || role === "member") return role;
	const custom = await db.query.organizationRole.findFirst({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, role),
		),
		columns: { id: true },
	});
	return custom ? role : "member";
};

/**
 * Decides whether an SSO callback may create an account: SSO must be on,
 * the provider enabled, and either just-in-time sign-up allowed or the
 * person already invited to the provider's organization.
 */
export const assertSsoSignUpAllowed = async (
	providerId: string | undefined,
	email: string,
) => {
	if (!(await isFlagEnabled("sso.enabled"))) throw deny("SSO is not enabled");
	const provider = providerId ? await loadProvider(providerId) : null;
	if (!provider?.enabled) throw deny("This SSO provider is not enabled");
	if (provider.jitEnabled) return;
	if (!(await pendingInvitation(email, provider.organizationId))) {
		throw deny("You need an invitation to join this organization");
	}
};

/**
 * Makes an SSO user a member of the provider's organization, honouring a
 * pending invitation's role.
 */
export const ensureSsoMembership = async (
	user: { id: string; email: string },
	providerId: string,
) => {
	const provider = await loadProvider(providerId);
	if (!provider) throw deny("Unknown SSO provider");
	const existing = await db.query.member.findFirst({
		where: and(
			eq(member.userId, user.id),
			eq(member.organizationId, provider.organizationId),
		),
	});
	if (existing) return { member: existing, created: false };

	const invite = await pendingInvitation(user.email, provider.organizationId);
	if (!invite && !provider.jitEnabled) {
		throw deny("You need an invitation to join this organization");
	}
	const role = await safeRole(
		invite?.role ?? provider.defaultRole,
		provider.organizationId,
	);
	const [created] = await db
		.insert(member)
		.values({
			organizationId: provider.organizationId,
			userId: user.id,
			role,
			createdAt: new Date(),
		})
		.returning();
	if (!created) throw deny("Could not add you to the organization");
	if (invite) {
		await db
			.update(invitation)
			.set({ status: "accepted" })
			.where(eq(invitation.id, invite.id));
	}
	await db
		.insert(abhashMemberMeta)
		.values({ memberId: created.id, roleSource: invite ? "manual" : "sso" })
		.onConflictDoNothing();
	return { member: created, created: true };
};

export const groupsFrom = (claim: unknown): string[] => {
	if (Array.isArray(claim)) return claim.map(String);
	if (typeof claim === "string") {
		return claim
			.split(/[,\s]+/)
			.map((g) => g.trim())
			.filter(Boolean);
	}
	return [];
};

/**
 * Runs on every SSO sign-in (Better Auth `provisionUser`). Syncs the
 * member's organization role and SSO-sourced team memberships from the
 * identity provider's groups, so a change in Authentik applies at the next
 * login. Throwing here aborts the sign-in before the session cookie is set.
 */
export const syncSsoUser = async (data: {
	user: { id: string; email: string };
	userInfo: Record<string, unknown>;
	provider: { providerId: string };
}) => {
	const { user, userInfo } = data;
	const provider = await loadProvider(data.provider.providerId);
	if (!provider?.enabled || !(await isFlagEnabled("sso.enabled"))) {
		throw deny("SSO is not enabled");
	}
	const orgId = provider.organizationId;
	const groups = groupsFrom(
		userInfo[provider.groupsClaim] ?? userInfo.groups,
	).map((g) => g.toLowerCase());

	const { member: row } = await ensureSsoMembership(user, provider.providerId);
	const mappings = (
		await db.query.abhashSsoGroupMapping.findMany({
			where: eq(abhashSsoGroupMapping.organizationId, orgId),
		})
	).filter(
		(m) =>
			(m.providerId === null || m.providerId === provider.providerId) &&
			groups.includes(m.groupName.toLowerCase()),
	);

	if (provider.requireGroupMatch && mappings.length === 0) {
		const meta = await db.query.abhashMemberMeta.findFirst({
			where: eq(abhashMemberMeta.memberId, row.id),
		});
		if (row.role !== "owner" && meta?.roleSource === "sso") {
			await db.delete(member).where(eq(member.id, row.id));
		}
		throw deny("None of your groups has access to this organization");
	}

	const meta = await db.query.abhashMemberMeta.findFirst({
		where: eq(abhashMemberMeta.memberId, row.id),
	});
	let role = row.role;
	if (row.role !== "owner" && !meta?.rolePinned) {
		const mapped = mappings
			.filter((m) => m.orgRole)
			.sort((a, b) => b.priority - a.priority)[0]?.orgRole;
		let desired = await safeRole(mapped ?? provider.defaultRole, orgId);
		if (desired === "admin" && provider.maxRole !== "admin") desired = "member";
		if (desired !== row.role) {
			await db
				.update(member)
				.set({ role: desired })
				.where(eq(member.id, row.id));
			role = desired;
		}
	}

	const orgTeams = await db.query.abhashTeam.findMany({
		where: eq(abhashTeam.organizationId, orgId),
		columns: { id: true },
	});
	const orgTeamIds = orgTeams.map((t) => t.id);
	const wanted = new Set(
		mappings.map((m) => m.teamId).filter((id): id is string => !!id),
	);
	if (orgTeamIds.length) {
		const current = await db.query.abhashTeamMember.findMany({
			where: and(
				eq(abhashTeamMember.userId, user.id),
				eq(abhashTeamMember.source, "sso"),
				inArray(abhashTeamMember.teamId, orgTeamIds),
			),
		});
		const stale = current
			.filter((c) => !wanted.has(c.teamId))
			.map((c) => c.teamId);
		if (stale.length) {
			await db
				.delete(abhashTeamMember)
				.where(
					and(
						eq(abhashTeamMember.userId, user.id),
						eq(abhashTeamMember.source, "sso"),
						inArray(abhashTeamMember.teamId, stale),
					),
				);
		}
	}
	if (wanted.size) {
		await db
			.insert(abhashTeamMember)
			.values(
				[...wanted].map((teamId) => ({
					teamId,
					userId: user.id,
					source: "sso" as const,
				})),
			)
			.onConflictDoNothing();
	}

	await db
		.insert(abhashMemberMeta)
		.values({ memberId: row.id, roleSource: "sso", lastSsoSyncAt: new Date() })
		.onConflictDoUpdate({
			target: abhashMemberMeta.memberId,
			set: {
				lastSsoSyncAt: new Date(),
				...(role !== row.role ? { roleSource: "sso" as const } : {}),
			},
		});
	await db
		.update(abhashSsoProvider)
		.set({ lastLoginAt: new Date() })
		.where(eq(abhashSsoProvider.providerId, provider.providerId));
	await createAuditLog({
		organizationId: orgId,
		userId: user.id,
		userEmail: user.email,
		userRole: role,
		action: "login",
		resourceType: "user",
		resourceId: user.id,
		metadata: {
			sso: provider.providerId,
			groups,
			role,
			roleChanged: role !== row.role ? { from: row.role } : undefined,
			teams: [...wanted],
		},
	});
};
