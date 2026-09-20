import { db } from "@dokploy/server/db";
import { abhashManagedService, compose } from "@dokploy/server/db/schema";
import {
	createDatabase,
	createManagedService,
	createUser,
	dropUser,
	ENGINES,
	enableExtension,
	generatePassword,
	listDatabases,
	listExtensions,
	listManagedServices,
	listUsers,
	POSTGRES_FLAVOURS,
	updateManagedService,
} from "@dokploy/server/services/abhash/engines";
import { assertServiceInOrganization } from "@dokploy/server/services/abhash/ownership";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

const sqlEngine = z.enum(["postgres", "mysql", "mariadb"]);

/**
 * Every database tool names a service by id. The id is checked against the
 * caller's organization before any of them runs, so none can forget to.
 */
const sqlToolProcedure = adminProcedure
	.input(
		z.object({ serviceId: z.string(), engine: sqlEngine.default("postgres") }),
	)
	.use(async ({ ctx, input, next }) => {
		await assertServiceInOrganization(
			ctx.session.activeOrganizationId,
			input.engine,
			input.serviceId,
		).catch((error) => {
			throw asTrpc(error);
		});
		return next();
	});
const configInput = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean()]),
);

export const abhashEnginesRouter = createTRPCRouter({
	catalog: adminProcedure.query(() => ({
		engines: ENGINES.map((engine) => ({
			id: engine.id,
			label: engine.label,
			category: engine.category,
			description: engine.description,
			versions: engine.versions,
			fields: engine.fields,
		})),
		postgresFlavours: POSTGRES_FLAVOURS,
	})),

	list: adminProcedure.query(async ({ ctx }) => {
		const rows = await listManagedServices(ctx.session.activeOrganizationId);
		if (rows.length === 0) return [];
		const stacks = await db.query.compose.findMany({
			where: inArray(
				compose.composeId,
				rows.map((row) => row.composeId),
			),
			columns: {
				composeId: true,
				name: true,
				appName: true,
				composeStatus: true,
			},
		});
		const byId = new Map(stacks.map((stack) => [stack.composeId, stack]));
		return rows.map((row) => ({
			...row,
			stack: byId.get(row.composeId) ?? null,
		}));
	}),

	create: adminProcedure
		.input(
			z.object({
				engineId: z.string(),
				environmentId: z.string(),
				name: z
					.string()
					.trim()
					.min(1)
					.max(40)
					.regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers and hyphens"),
				version: z.string().optional(),
				config: configInput.default({}),
				serverId: z.string().nullable().default(null),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const result = await createManagedService({
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					...input,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "compose",
					resourceId: result.composeId,
					resourceName: `${input.engineId}: ${input.name}`,
				});
				return result;
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	update: adminProcedure
		.input(
			z.object({
				id: z.string(),
				version: z.string().optional(),
				config: configInput.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const result = await updateManagedService(
					ctx.session.activeOrganizationId,
					input.id,
					input,
				);
				await audit(ctx, {
					action: "update",
					resourceType: "compose",
					resourceId: result.composeId,
					resourceName: "managed service",
				});
				return result;
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	forget: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			// Only the link is dropped; the stack itself is deleted from the
			// project page, like any other compose service.
			await db
				.delete(abhashManagedService)
				.where(
					and(
						eq(abhashManagedService.id, input.id),
						eq(
							abhashManagedService.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			return true;
		}),

	/** Users, databases and extensions on a database Dokploy already runs. */
	tools: createTRPCRouter({
		overview: sqlToolProcedure
			.input(z.object({ engine: sqlEngine, serviceId: z.string() }))
			.query(async ({ input }) => {
				try {
					const [databases, users] = await Promise.all([
						listDatabases(input.engine, input.serviceId),
						listUsers(input.engine, input.serviceId),
					]);
					const extensions =
						input.engine === "postgres"
							? await listExtensions(input.serviceId)
							: null;
					return { databases, users, extensions };
				} catch (error) {
					throw asTrpc(error);
				}
			}),

		createDatabase: sqlToolProcedure
			.input(
				z.object({
					engine: sqlEngine,
					serviceId: z.string(),
					name: z.string().trim().min(1).max(60),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				try {
					await createDatabase(input.engine, input.serviceId, input.name);
				} catch (error) {
					throw asTrpc(error);
				}
				await audit(ctx, {
					action: "create",
					resourceType: "service",
					resourceId: input.serviceId,
					resourceName: `database ${input.name}`,
				});
				return true;
			}),

		createUser: sqlToolProcedure
			.input(
				z.object({
					engine: sqlEngine,
					serviceId: z.string(),
					username: z.string().trim().min(1).max(60),
					database: z.string().trim().max(60).optional(),
					readOnly: z.boolean().default(false),
					/** Left empty, Dokploy generates one and returns it once. */
					password: z.string().max(200).optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const password = input.password || generatePassword();
				try {
					await createUser(input.engine, input.serviceId, {
						username: input.username,
						password,
						database: input.database,
						readOnly: input.readOnly,
					});
				} catch (error) {
					throw asTrpc(error);
				}
				await audit(ctx, {
					action: "create",
					resourceType: "service",
					resourceId: input.serviceId,
					resourceName: `db user ${input.username}`,
					metadata: { readOnly: input.readOnly, database: input.database },
				});
				// Shown once, like an API key.
				return { username: input.username, password };
			}),

		dropUser: sqlToolProcedure
			.input(
				z.object({
					engine: sqlEngine,
					serviceId: z.string(),
					username: z.string().trim().min(1).max(60),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				try {
					await dropUser(input.engine, input.serviceId, input.username);
				} catch (error) {
					throw asTrpc(error);
				}
				await audit(ctx, {
					action: "delete",
					resourceType: "service",
					resourceId: input.serviceId,
					resourceName: `db user ${input.username}`,
				});
				return true;
			}),

		enableExtension: sqlToolProcedure
			.input(
				z.object({
					serviceId: z.string(),
					name: z.string().trim().min(1).max(60),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				try {
					await enableExtension(input.serviceId, input.name);
				} catch (error) {
					throw asTrpc(error);
				}
				await audit(ctx, {
					action: "update",
					resourceType: "service",
					resourceId: input.serviceId,
					resourceName: `extension ${input.name}`,
				});
				return true;
			}),
	}),
});
