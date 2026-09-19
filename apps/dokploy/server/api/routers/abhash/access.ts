import { db } from "@dokploy/server/db";
import {
	abhashMemberMeta,
	abhashRoleBinding,
	abhashTeam,
	abhashTeamMember,
	gitProvider,
	member,
	organizationRole,
	projects,
	server,
} from "@dokploy/server/db/schema";
import { setSetting } from "@dokploy/server/services/abhash/flags";
import {
	ancestry,
	BINDING_ROLES,
	explainAccess,
	rbacV2Enabled,
	syncAllLegacyBindings,
} from "@dokploy/server/services/abhash/rbac";
import {
	reactivateUser,
	suspendUser,
} from "@dokploy/server/services/abhash/suspension";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "../../trpc";

const scopeType = z.enum([
	"organization",
	"project",
	"environment",
	"service",
	"server",
	"gitProvider",
]);

const slugify = (name: string) =>
	name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "team";

const notFound = (what: string) =>
	new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

const ownerOnly = (role: string) => {
	if (role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the organization owner can change this",
		});
	}
};

/** Rejects a scope that does not exist or belongs to another organization. */
const assertScopeInOrg = async (
	organizationId: string,
	type: z.infer<typeof scopeType>,
	id: string,
) => {
	if (type === "organization") return;
	let ok = false;
	if (type === "project" || type === "environment" || type === "service") {
		const chain = await ancestry({ type, id });
		const projectId = chain.find((ref) => ref.type === "project")?.id;
		// ancestry() only reaches the project when the target exists.
		if (projectId && (type === "project" || chain.length > 2)) {
			const p = await db.query.projects.findFirst({
				where: eq(projects.projectId, projectId),
				columns: { organizationId: true },
			});
			ok = p?.organizationId === organizationId;
		}
	} else if (type === "server") {
		const s = await db.query.server.findFirst({
			where: eq(server.serverId, id),
			columns: { organizationId: true },
		});
		ok = s?.organizationId === organizationId;
	} else {
		const g = await db.query.gitProvider.findFirst({
			where: eq(gitProvider.gitProviderId, id),
			columns: { organizationId: true },
		});
		ok = g?.organizationId === organizationId;
	}
	if (!ok) throw notFound("Scope");
};

const assertBindingRole = async (organizationId: string, role: string) => {
	if (role in BINDING_ROLES) return;
	const custom = await db.query.organizationRole.findFirst({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, role),
		),
		columns: { id: true },
	});
	if (!custom) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Unknown role "${role}"`,
		});
	}
};

const assertSubjectInOrg = async (
	organizationId: string,
	subjectType: "user" | "team",
	subjectId: string,
) => {
	const found =
		subjectType === "user"
			? await db.query.member.findFirst({
					where: and(
						eq(member.organizationId, organizationId),
						eq(member.userId, subjectId),
					),
					columns: { id: true },
				})
			: await db.query.abhashTeam.findFirst({
					where: and(
						eq(abhashTeam.organizationId, organizationId),
						eq(abhashTeam.id, subjectId),
					),
					columns: { id: true },
				});
	if (!found) throw notFound(subjectType === "user" ? "Member" : "Team");
};

const displayName = (u: { firstName: string; lastName: string }) =>
	`${u.firstName} ${u.lastName}`.trim();

const teamsRouter = createTRPCRouter({
	list: withPermission("member", "read").query(async ({ ctx }) => {
		const teams = await db.query.abhashTeam.findMany({
			where: eq(abhashTeam.organizationId, ctx.session.activeOrganizationId),
			with: {
				members: {
					with: {
						user: {
							columns: {
								id: true,
								firstName: true,
								lastName: true,
								email: true,
								image: true,
							},
						},
					},
				},
			},
			orderBy: (t, { asc }) => [asc(t.name)],
		});
		return teams.map((team) => ({
			...team,
			members: team.members.map((m) => ({
				...m,
				user: { ...m.user, name: displayName(m.user) },
			})),
		}));
	}),

	create: adminProcedure
		.input(
			z.object({
				name: z.string().trim().min(1).max(80),
				description: z.string().trim().max(300).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const [team] = await db
				.insert(abhashTeam)
				.values({
					organizationId: orgId,
					name: input.name,
					slug: slugify(input.name),
					description: input.description,
				})
				.onConflictDoNothing()
				.returning();
			if (!team) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "A team with this name already exists",
				});
			}
			await audit(ctx, {
				action: "create",
				resourceType: "team",
				resourceId: team.id,
				resourceName: team.name,
			});
			return team;
		}),

	update: adminProcedure
		.input(
			z.object({
				teamId: z.string(),
				name: z.string().trim().min(1).max(80),
				description: z.string().trim().max(300).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const [team] = await db
				.update(abhashTeam)
				.set({
					name: input.name,
					slug: slugify(input.name),
					description: input.description,
				})
				.where(
					and(
						eq(abhashTeam.id, input.teamId),
						eq(abhashTeam.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.returning();
			if (!team) throw notFound("Team");
			await audit(ctx, {
				action: "update",
				resourceType: "team",
				resourceId: team.id,
				resourceName: team.name,
			});
			return team;
		}),

	remove: adminProcedure
		.input(z.object({ teamId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const [team] = await db
				.delete(abhashTeam)
				.where(
					and(
						eq(abhashTeam.id, input.teamId),
						eq(abhashTeam.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.returning();
			if (!team) throw notFound("Team");
			await audit(ctx, {
				action: "delete",
				resourceType: "team",
				resourceId: team.id,
				resourceName: team.name,
			});
			return true;
		}),

	setMembers: adminProcedure
		.input(z.object({ teamId: z.string(), userIds: z.array(z.string()) }))
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const team = await db.query.abhashTeam.findFirst({
				where: and(
					eq(abhashTeam.id, input.teamId),
					eq(abhashTeam.organizationId, orgId),
				),
			});
			if (!team) throw notFound("Team");
			const members = input.userIds.length
				? await db.query.member.findMany({
						where: and(
							eq(member.organizationId, orgId),
							inArray(member.userId, input.userIds),
						),
						columns: { userId: true },
					})
				: [];
			if (members.length !== new Set(input.userIds).size) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Every team member must belong to this organization",
				});
			}
			// Only manual memberships are edited here; SSO/SCIM rows stay as synced.
			await db.transaction(async (tx) => {
				await tx
					.delete(abhashTeamMember)
					.where(
						and(
							eq(abhashTeamMember.teamId, team.id),
							eq(abhashTeamMember.source, "manual"),
						),
					);
				if (input.userIds.length) {
					await tx
						.insert(abhashTeamMember)
						.values(
							[...new Set(input.userIds)].map((userId) => ({
								teamId: team.id,
								userId,
								source: "manual" as const,
							})),
						)
						.onConflictDoNothing();
				}
			});
			await audit(ctx, {
				action: "update",
				resourceType: "team",
				resourceId: team.id,
				resourceName: team.name,
				metadata: { members: input.userIds },
			});
			return true;
		}),
});

const bindingsRouter = createTRPCRouter({
	list: withPermission("member", "read")
		.input(
			z
				.object({
					subjectType: z.enum(["user", "team"]).optional(),
					subjectId: z.string().optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) =>
			db.query.abhashRoleBinding.findMany({
				where: and(
					eq(
						abhashRoleBinding.organizationId,
						ctx.session.activeOrganizationId,
					),
					...(input?.subjectType
						? [eq(abhashRoleBinding.subjectType, input.subjectType)]
						: []),
					...(input?.subjectId
						? [eq(abhashRoleBinding.subjectId, input.subjectId)]
						: []),
				),
				orderBy: (b, { asc }) => [asc(b.createdAt)],
			}),
		),

	create: adminProcedure
		.input(
			z.object({
				subjectType: z.enum(["user", "team"]),
				subjectId: z.string(),
				role: z.string().min(1),
				scopeType,
				scopeId: z.string().default(""),
				inherit: z.boolean().default(true),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const scopeId = input.scopeType === "organization" ? "" : input.scopeId;
			if (input.scopeType !== "organization" && !scopeId) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a scope" });
			}
			await assertSubjectInOrg(orgId, input.subjectType, input.subjectId);
			await assertBindingRole(orgId, input.role);
			await assertScopeInOrg(orgId, input.scopeType, scopeId);
			const [binding] = await db
				.insert(abhashRoleBinding)
				.values({
					organizationId: orgId,
					subjectType: input.subjectType,
					subjectId: input.subjectId,
					role: input.role,
					scopeType: input.scopeType,
					scopeId,
					inherit: input.inherit,
					source: "manual",
					createdBy: ctx.user.id,
				})
				.onConflictDoNothing()
				.returning();
			await audit(ctx, {
				action: "create",
				resourceType: "roleBinding",
				resourceId: binding?.id,
				metadata: { ...input, scopeId },
			});
			return binding ?? null;
		}),

	remove: adminProcedure
		.input(z.object({ bindingId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const [binding] = await db
				.delete(abhashRoleBinding)
				.where(
					and(
						eq(abhashRoleBinding.id, input.bindingId),
						eq(
							abhashRoleBinding.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				)
				.returning();
			if (!binding) throw notFound("Grant");
			await audit(ctx, {
				action: "delete",
				resourceType: "roleBinding",
				resourceId: binding.id,
				metadata: binding,
			});
			return true;
		}),
});

const membersRouter = createTRPCRouter({
	list: withPermission("member", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const [rows, teams, suspensions, metas] = await Promise.all([
			db.query.member.findMany({
				where: eq(member.organizationId, orgId),
				with: {
					user: {
						columns: {
							id: true,
							firstName: true,
							lastName: true,
							email: true,
							image: true,
							banned: true,
							twoFactorEnabled: true,
						},
					},
				},
				orderBy: (m, { asc }) => [asc(m.createdAt)],
			}),
			db
				.select({
					userId: abhashTeamMember.userId,
					teamId: abhashTeam.id,
					name: abhashTeam.name,
				})
				.from(abhashTeamMember)
				.innerJoin(abhashTeam, eq(abhashTeam.id, abhashTeamMember.teamId))
				.where(eq(abhashTeam.organizationId, orgId)),
			db.query.abhashUserSuspension.findMany(),
			db.query.abhashMemberMeta.findMany(),
		]);
		const suspended = new Map(suspensions.map((s) => [s.userId, s]));
		const meta = new Map(metas.map((m) => [m.memberId, m]));
		return rows.map((row) => ({
			memberId: row.id,
			userId: row.userId,
			role: row.role,
			createdAt: row.createdAt,
			user: { ...row.user, name: displayName(row.user) },
			teams: [
				...new Map(
					teams
						.filter((t) => t.userId === row.userId)
						.map((t) => [t.teamId, { id: t.teamId, name: t.name }]),
				).values(),
			],
			suspension: suspended.get(row.userId) ?? null,
			roleSource: meta.get(row.id)?.roleSource ?? "manual",
			rolePinned: meta.get(row.id)?.rolePinned ?? false,
		}));
	}),

	suspend: adminProcedure
		.input(
			z.object({ userId: z.string(), reason: z.string().max(300).optional() }),
		)
		.mutation(async ({ ctx, input }) => {
			await suspendUser({
				userId: input.userId,
				actorId: ctx.user.id,
				source: "manual",
				reason: input.reason,
			});
			await audit(ctx, {
				action: "suspend",
				resourceType: "user",
				resourceId: input.userId,
				metadata: { reason: input.reason },
			});
			return true;
		}),

	reactivate: adminProcedure
		.input(z.object({ userId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await reactivateUser({ userId: input.userId, actorId: ctx.user.id });
			await audit(ctx, {
				action: "reactivate",
				resourceType: "user",
				resourceId: input.userId,
			});
			return true;
		}),

	setRolePinned: adminProcedure
		.input(z.object({ memberId: z.string(), pinned: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const row = await db.query.member.findFirst({
				where: and(
					eq(member.id, input.memberId),
					eq(member.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!row) throw notFound("Member");
			await db
				.insert(abhashMemberMeta)
				.values({ memberId: row.id, rolePinned: input.pinned })
				.onConflictDoUpdate({
					target: abhashMemberMeta.memberId,
					set: { rolePinned: input.pinned },
				});
			await audit(ctx, {
				action: "update",
				resourceType: "user",
				resourceId: row.userId,
				metadata: { rolePinned: input.pinned },
			});
			return true;
		}),
});

export const abhashAccessRouter = createTRPCRouter({
	status: protectedProcedure.query(async () => ({
		rbacV2: await rbacV2Enabled(),
	})),

	setEnabled: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx.user.role);
			let mirrored = 0;
			// Mirror the legacy lists first, so nobody loses or gains access at
			// the moment the new engine takes over.
			if (input.enabled) mirrored = await syncAllLegacyBindings();
			await setSetting("rbac.v2", input.enabled, ctx.user.id);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "rbac.v2",
				metadata: { enabled: input.enabled, mirroredMembers: mirrored },
			});
			return { enabled: input.enabled, mirroredMembers: mirrored };
		}),

	roles: withPermission("member", "read").query(async ({ ctx }) => {
		const custom = await db.query.organizationRole.findMany({
			where: eq(
				organizationRole.organizationId,
				ctx.session.activeOrganizationId,
			),
			columns: { role: true },
		});
		return [
			...Object.entries(BINDING_ROLES).map(([key, value]) => ({
				role: key,
				label: value.label,
				builtin: true,
			})),
			...[...new Set(custom.map((c) => c.role))].map((role) => ({
				role,
				label: role,
				builtin: false,
			})),
		];
	}),

	scopes: adminProcedure.query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const [projectRows, servers, providers] = await Promise.all([
			db.query.projects.findMany({
				where: eq(projects.organizationId, orgId),
				columns: { projectId: true, name: true },
				with: {
					environments: {
						columns: { environmentId: true, name: true },
						with: {
							applications: { columns: { applicationId: true, name: true } },
							compose: { columns: { composeId: true, name: true } },
							postgres: { columns: { postgresId: true, name: true } },
							mysql: { columns: { mysqlId: true, name: true } },
							mariadb: { columns: { mariadbId: true, name: true } },
							mongo: { columns: { mongoId: true, name: true } },
							redis: { columns: { redisId: true, name: true } },
							libsql: { columns: { libsqlId: true, name: true } },
						},
					},
				},
				orderBy: (p, { asc }) => [asc(p.name)],
			}),
			db.query.server.findMany({
				where: eq(server.organizationId, orgId),
				columns: { serverId: true, name: true },
			}),
			db.query.gitProvider.findMany({
				where: eq(gitProvider.organizationId, orgId),
				columns: { gitProviderId: true, name: true, providerType: true },
			}),
		]);
		return {
			projects: projectRows.map((p) => ({
				id: p.projectId,
				name: p.name,
				environments: p.environments.map((e) => ({
					id: e.environmentId,
					name: e.name,
					services: [
						...e.applications.map((s) => ({
							id: s.applicationId,
							name: s.name,
							type: "application",
						})),
						...e.compose.map((s) => ({
							id: s.composeId,
							name: s.name,
							type: "compose",
						})),
						...e.postgres.map((s) => ({
							id: s.postgresId,
							name: s.name,
							type: "postgres",
						})),
						...e.mysql.map((s) => ({
							id: s.mysqlId,
							name: s.name,
							type: "mysql",
						})),
						...e.mariadb.map((s) => ({
							id: s.mariadbId,
							name: s.name,
							type: "mariadb",
						})),
						...e.mongo.map((s) => ({
							id: s.mongoId,
							name: s.name,
							type: "mongo",
						})),
						...e.redis.map((s) => ({
							id: s.redisId,
							name: s.name,
							type: "redis",
						})),
						...e.libsql.map((s) => ({
							id: s.libsqlId,
							name: s.name,
							type: "libsql",
						})),
					],
				})),
			})),
			servers: servers.map((s) => ({ id: s.serverId, name: s.name })),
			gitProviders: providers.map((g) => ({
				id: g.gitProviderId,
				name: g.name,
				type: g.providerType,
			})),
		};
	}),

	explain: adminProcedure
		.input(
			z.object({
				userId: z.string(),
				scopeType: scopeType.exclude(["organization"]),
				scopeId: z.string(),
			}),
		)
		.query(async ({ ctx, input }) =>
			explainAccess(input.userId, ctx.session.activeOrganizationId, {
				type: input.scopeType,
				id: input.scopeId,
			}),
		),

	teams: teamsRouter,
	bindings: bindingsRouter,
	members: membersRouter,
});
