import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { abhashRoleBinding, member } from "../../../db/schema";
import type { BindingScope } from "../../../db/schema/abhash-rbac";
import { isFlagEnabled } from "../flags";
import {
	accessibleIds,
	checkPermission,
	checkScoped,
	findMemberWithAccess,
	grantCreator,
	type RbacCtx,
	resolvePermissions,
} from "./resolver";
import { ORG_ROLE } from "./roles";

export const rbacV2Enabled = () => isFlagEnabled("rbac.v2");

type Permissions = Record<string, readonly string[]>;

/**
 * Role-binding implementations of services/permission.ts. Each function has
 * the signature of its legacy counterpart; permission.ts delegates here when
 * the rbac.v2 flag is on.
 */
export const rbacV2 = {
	checkPermission: (ctx: RbacCtx, permissions: Permissions) =>
		checkPermission(ctx, permissions),

	resolvePermissions,

	findMemberByUserId: findMemberWithAccess,

	checkProjectAccess: (
		ctx: RbacCtx,
		action: "create" | "delete",
		projectId?: string,
	) =>
		action === "create" || !projectId
			? checkPermission(ctx, { project: [action] })
			: checkScoped(
					ctx,
					{ type: "project", id: projectId },
					{ project: [action] },
					"You don't have access to this project",
				),

	checkServicePermissionAndAccess: (
		ctx: RbacCtx,
		serviceId: string,
		permissions: Permissions,
	) =>
		checkScoped(
			ctx,
			{ type: "service", id: serviceId },
			permissions,
			"You don't have access to this service",
		),

	// Legacy quirk kept: for "create" the id is the target project.
	checkServiceAccess: (
		ctx: RbacCtx,
		serviceId: string,
		action: "create" | "read" | "delete" = "read",
	) =>
		action === "create"
			? checkScoped(
					ctx,
					{ type: "project", id: serviceId },
					{ service: ["create"] },
					"You don't have access to this project",
				)
			: checkScoped(
					ctx,
					{ type: "service", id: serviceId },
					{ service: [action] },
					"You don't have access to this service",
				),

	checkEnvironmentAccess: (
		ctx: RbacCtx,
		environmentId: string,
		action: "read" | "create" | "delete" = "read",
	) =>
		action === "create"
			? checkPermission(ctx, { environment: ["create"] })
			: checkScoped(
					ctx,
					{ type: "environment", id: environmentId },
					{ environment: [action] },
					"You don't have access to this environment",
				),

	checkEnvironmentCreationPermission: (ctx: RbacCtx, projectId: string) =>
		checkScoped(
			ctx,
			{ type: "project", id: projectId },
			{ environment: ["create"] },
			"You don't have access to this project",
		),

	checkEnvironmentDeletionPermission: (ctx: RbacCtx, projectId: string) =>
		checkScoped(
			ctx,
			{ type: "project", id: projectId },
			{ environment: ["delete"] },
			"You don't have access to this project",
		),

	grantCreator: (ctx: RbacCtx, scopeType: BindingScope, id: string) =>
		grantCreator(ctx, scopeType, id),

	accessibleIds,
};

const LEGACY_SCOPES: [keyof typeof member.$inferSelect, BindingScope][] = [
	["accessedProjects", "project"],
	["accessedEnvironments", "environment"],
	["accessedServices", "service"],
	["accessedServers", "server"],
	["accessedGitProviders", "gitProvider"],
];

/**
 * Mirrors a member's legacy access lists into "@org" bindings without
 * inheritance, which reproduces the legacy decisions exactly. Run when the
 * flag is turned on and whenever the legacy lists change.
 */
export const syncLegacyBindings = async (memberId: string) => {
	const row = await db.query.member.findFirst({
		where: eq(member.id, memberId),
	});
	if (!row) return;
	const wanted = LEGACY_SCOPES.flatMap(([column, scopeType]) =>
		((row[column] as string[] | null) ?? []).map((scopeId) => ({
			scopeType,
			scopeId,
		})),
	);
	await db.transaction(async (tx) => {
		const keep = wanted.map((w) => `${w.scopeType}:${w.scopeId}`);
		const existing = await tx.query.abhashRoleBinding.findMany({
			where: and(
				eq(abhashRoleBinding.organizationId, row.organizationId),
				eq(abhashRoleBinding.subjectType, "user"),
				eq(abhashRoleBinding.subjectId, row.userId),
				eq(abhashRoleBinding.source, "legacy"),
			),
			columns: { id: true, scopeType: true, scopeId: true },
		});
		const stale = existing
			.filter((b) => !keep.includes(`${b.scopeType}:${b.scopeId}`))
			.map((b) => b.id);
		if (stale.length) {
			await tx
				.delete(abhashRoleBinding)
				.where(inArray(abhashRoleBinding.id, stale));
		}
		if (wanted.length) {
			await tx
				.insert(abhashRoleBinding)
				.values(
					wanted.map((w) => ({
						organizationId: row.organizationId,
						subjectType: "user" as const,
						subjectId: row.userId,
						role: ORG_ROLE,
						scopeType: w.scopeType,
						scopeId: w.scopeId,
						inherit: false,
						source: "legacy" as const,
					})),
				)
				.onConflictDoNothing();
		}
	});
};

/** Called after the legacy permission editor changes a member's lists. */
export const syncLegacyBindingsForUser = async (
	userId: string,
	organizationId: string,
) => {
	if (!(await rbacV2Enabled())) return;
	const row = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		columns: { id: true },
	});
	if (row) await syncLegacyBindings(row.id);
};

export const syncAllLegacyBindings = async () => {
	const members = await db.query.member.findMany({ columns: { id: true } });
	for (const m of members) await syncLegacyBindings(m.id);
	return members.length;
};

export { explainAccess } from "./explain";
export { BINDING_ROLES, ORG_ROLE } from "./roles";
export { ancestry } from "./scope";
export type { RbacCtx };
