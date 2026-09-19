import { db } from "@dokploy/server/db";
import {
	member,
	organization,
	organizationRole,
} from "@dokploy/server/db/schema";
import { statements } from "@dokploy/server/lib/access-control";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const RESERVED_ROLE_NAMES = new Set([
	"owner",
	"admin",
	"member",
	"viewer",
	"developer",
]);

// Organization lifecycle, teams and the access-control resource itself stay
// with owners/admins; a custom role can never grant them.
const NON_ASSIGNABLE_RESOURCES = new Set(["organization", "team", "ac"]);

const MAX_CUSTOM_ROLES = 50;

type Statements = typeof statements;
type Resource = keyof Statements;

const roleName = z
	.string()
	.trim()
	.min(1)
	.max(50)
	.regex(
		/^[a-zA-Z0-9_-]+$/,
		"Only letters, numbers, hyphens, and underscores allowed",
	)
	.refine((name) => !RESERVED_ROLE_NAMES.has(name.toLowerCase()), {
		message: "This name is reserved for a built-in role",
	});

const permissionsInput = z
	.record(z.string(), z.array(z.string()))
	.superRefine((permissions, ctx) => {
		for (const [resource, actions] of Object.entries(permissions)) {
			if (NON_ASSIGNABLE_RESOURCES.has(resource) || !(resource in statements)) {
				ctx.addIssue({
					code: "custom",
					message: `Unknown or non-assignable resource: ${resource}`,
				});
				continue;
			}
			const allowed = statements[resource as Resource] as readonly string[];
			for (const action of actions) {
				if (!allowed.includes(action)) {
					ctx.addIssue({
						code: "custom",
						message: `Unknown action "${action}" for ${resource}`,
					});
				}
			}
		}
	});

type Permissions = Record<string, string[]>;

const normalize = (permissions: Permissions): Permissions =>
	Object.fromEntries(
		Object.entries(permissions)
			.filter(([, actions]) => actions.length > 0)
			.map(([resource, actions]) => [resource, [...new Set(actions)].sort()]),
	);

// Several rows for one role name are merged, matching how permission.ts
// resolves a custom role.
const mergeRows = (rows: { permission: string }[]): Permissions => {
	const merged: Record<string, Set<string>> = {};
	for (const row of rows) {
		const parsed = JSON.parse(row.permission) as Permissions;
		for (const [resource, actions] of Object.entries(parsed)) {
			merged[resource] ??= new Set();
			for (const action of actions) merged[resource].add(action);
		}
	}
	return Object.fromEntries(
		Object.entries(merged).map(([resource, actions]) => [
			resource,
			[...actions].sort(),
		]),
	);
};

const rolesOf = async (organizationId: string) => {
	const rows = await db.query.organizationRole.findMany({
		where: eq(organizationRole.organizationId, organizationId),
		orderBy: (role, { asc }) => [asc(role.createdAt)],
	});
	const byName = new Map<string, typeof rows>();
	for (const row of rows) {
		byName.set(row.role, [...(byName.get(row.role) ?? []), row]);
	}
	return byName;
};

const memberCount = async (organizationId: string, role: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(member)
		.where(
			and(eq(member.organizationId, organizationId), eq(member.role, role)),
		);
	return row?.n ?? 0;
};

export const abhashCustomRoleRouter = createTRPCRouter({
	all: protectedProcedure.query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const roles = await rolesOf(orgId);
		return Promise.all(
			[...roles.entries()].map(async ([role, rows]) => ({
				role,
				permissions: mergeRows(rows),
				createdAt: rows[0]?.createdAt ?? null,
				memberCount: await memberCount(orgId, role),
			})),
		);
	}),

	getStatements: protectedProcedure.query(() => ({
		statements: Object.fromEntries(
			Object.entries(statements).filter(
				([resource]) => !NON_ASSIGNABLE_RESOURCES.has(resource),
			),
		) as Partial<Record<Resource, readonly string[]>>,
	})),

	membersByRole: protectedProcedure
		.input(z.object({ roleName: z.string().min(1) }))
		.query(async ({ ctx, input }) =>
			db.query.member.findMany({
				where: and(
					eq(member.organizationId, ctx.session.activeOrganizationId),
					eq(member.role, input.roleName),
				),
				with: { user: { columns: { id: true, name: true, email: true } } },
			}),
		),

	create: adminProcedure
		.input(z.object({ roleName, permissions: permissionsInput }))
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const roles = await rolesOf(orgId);
			if (roles.has(input.roleName)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Role "${input.roleName}" already exists`,
				});
			}
			if (roles.size >= MAX_CUSTOM_ROLES) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `An organization can have at most ${MAX_CUSTOM_ROLES} custom roles`,
				});
			}
			const permissions = normalize(input.permissions);
			await db.insert(organizationRole).values({
				organizationId: orgId,
				role: input.roleName,
				permission: JSON.stringify(permissions),
			});
			await audit(ctx, {
				action: "create",
				resourceType: "customRole",
				resourceName: input.roleName,
				metadata: { permissions },
			});
			return { role: input.roleName, permissions };
		}),

	update: adminProcedure
		.input(
			z.object({
				roleName: z.string().min(1),
				newRoleName: roleName.optional(),
				permissions: permissionsInput,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const roles = await rolesOf(orgId);
			if (!roles.has(input.roleName)) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" });
			}
			const newName = input.newRoleName ?? input.roleName;
			if (newName !== input.roleName && roles.has(newName)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Role "${newName}" already exists`,
				});
			}
			const permissions = normalize(input.permissions);

			await db.transaction(async (tx) => {
				await tx
					.delete(organizationRole)
					.where(
						and(
							eq(organizationRole.organizationId, orgId),
							eq(organizationRole.role, input.roleName),
						),
					);
				await tx.insert(organizationRole).values({
					organizationId: orgId,
					role: newName,
					permission: JSON.stringify(permissions),
				});
				if (newName !== input.roleName) {
					await tx
						.update(member)
						.set({ role: newName })
						.where(
							and(
								eq(member.organizationId, orgId),
								eq(member.role, input.roleName),
							),
						);
					await tx
						.update(organization)
						.set({ defaultRole: newName })
						.where(
							and(
								eq(organization.id, orgId),
								eq(organization.defaultRole, input.roleName),
							),
						);
				}
			});

			await audit(ctx, {
				action: "update",
				resourceType: "customRole",
				resourceName: newName,
				metadata: {
					permissions,
					...(newName !== input.roleName
						? { renamedFrom: input.roleName }
						: {}),
				},
			});
			return { role: newName, permissions };
		}),

	remove: adminProcedure
		.input(z.object({ roleName: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const org = await db.query.organization.findFirst({
				where: eq(organization.id, orgId),
				columns: { defaultRole: true },
			});
			if (org?.defaultRole === input.roleName) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"This is the organization's default role for new members; choose another default first",
				});
			}
			const assigned = await memberCount(orgId, input.roleName);
			if (assigned > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Reassign the ${assigned} member(s) with this role before deleting it`,
				});
			}
			await db
				.delete(organizationRole)
				.where(
					and(
						eq(organizationRole.organizationId, orgId),
						eq(organizationRole.role, input.roleName),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "customRole",
				resourceName: input.roleName,
			});
			return true;
		}),
});
