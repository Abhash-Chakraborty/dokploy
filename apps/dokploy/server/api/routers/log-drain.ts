import {
	buildDeployLogDrainCommand,
	buildRemoveLogDrainCommand,
	buildValidateLogDrainCommand,
	buildVectorConfig,
	execAsync,
	execAsyncRemote,
	findServerById,
	redactLogDrainConfig,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	apiCreateLogDrain,
	apiFindOneLogDrain,
	apiUpdateLogDrain,
	logDrain,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../trpc";

type Ctx = { session: { activeOrganizationId: string } };

const findDrain = async (logDrainId: string, ctx: Ctx) => {
	const drain = await db.query.logDrain.findFirst({
		where: and(
			eq(logDrain.logDrainId, logDrainId),
			eq(logDrain.organizationId, ctx.session.activeOrganizationId),
		),
	});
	if (!drain) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Log drain not found" });
	}
	return drain;
};

const assertServerInOrg = async (
	serverId: string | null | undefined,
	ctx: Ctx,
) => {
	if (!serverId) return;
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to use this server",
		});
	}
};

const run = async (serverId: string | null | undefined, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const hostnameFor = async (serverId: string | null | undefined) => {
	if (!serverId) return "dokploy-host";
	const server = await findServerById(serverId);
	return server.name;
};

export const logDrainRouter = createTRPCRouter({
	all: adminProcedure.query(async ({ ctx }) => {
		const drains = await db.query.logDrain.findMany({
			where: eq(logDrain.organizationId, ctx.session.activeOrganizationId),
		});
		// Never hand credentials back to the client.
		return drains.map((drain) => ({
			...drain,
			config: redactLogDrainConfig(drain.config),
		}));
	}),

	one: adminProcedure
		.input(apiFindOneLogDrain)
		.query(async ({ input, ctx }) => {
			const drain = await findDrain(input.logDrainId, ctx);
			return { ...drain, config: redactLogDrainConfig(drain.config) };
		}),

	create: adminProcedure
		.input(apiCreateLogDrain)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrg(input.serverId, ctx);
			const [created] = await db
				.insert(logDrain)
				.values({
					name: input.name,
					drainType: input.config.drainType,
					config: input.config,
					enabled: input.enabled,
					serverId: input.serverId ?? null,
					organizationId: ctx.session.activeOrganizationId,
				})
				.returning();

			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceName: `log-drain:${input.name}`,
			});
			return created;
		}),

	update: adminProcedure
		.input(apiUpdateLogDrain)
		.mutation(async ({ input, ctx }) => {
			const existing = await findDrain(input.logDrainId, ctx);
			await assertServerInOrg(input.serverId ?? existing.serverId, ctx);

			const [updated] = await db
				.update(logDrain)
				.set({
					...(input.name ? { name: input.name } : {}),
					...(input.config
						? { config: input.config, drainType: input.config.drainType }
						: {}),
					...(input.enabled === undefined ? {} : { enabled: input.enabled }),
					...(input.serverId === undefined
						? {}
						: { serverId: input.serverId ?? null }),
				})
				.where(eq(logDrain.logDrainId, input.logDrainId))
				.returning();

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `log-drain:${updated?.name ?? input.logDrainId}`,
			});
			return updated;
		}),

	remove: adminProcedure
		.input(apiFindOneLogDrain)
		.mutation(async ({ input, ctx }) => {
			const drain = await findDrain(input.logDrainId, ctx);
			// Stop shipping before the config disappears, but don't block deletion
			// on an unreachable host.
			try {
				await run(drain.serverId, buildRemoveLogDrainCommand());
			} catch (error) {
				console.warn(
					"Could not stop the log shipper while deleting the drain:",
					error instanceof Error ? error.message : error,
				);
			}
			await db
				.delete(logDrain)
				.where(eq(logDrain.logDrainId, drain.logDrainId));
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: `log-drain:${drain.name}`,
			});
			return true;
		}),

	/** Parses the generated config with Vector without shipping anything. */
	validate: adminProcedure
		.input(apiFindOneLogDrain)
		.mutation(async ({ input, ctx }) => {
			const drain = await findDrain(input.logDrainId, ctx);
			const config = buildVectorConfig(drain.config, {
				hostname: await hostnameFor(drain.serverId),
			});
			try {
				const { stdout } = await run(
					drain.serverId,
					buildValidateLogDrainCommand(config),
				);
				return { valid: true, output: stdout.trim() };
			} catch (error) {
				return {
					valid: false,
					output: error instanceof Error ? error.message : String(error),
				};
			}
		}),

	deploy: adminProcedure
		.input(apiFindOneLogDrain)
		.mutation(async ({ input, ctx }) => {
			const drain = await findDrain(input.logDrainId, ctx);
			const config = buildVectorConfig(drain.config, {
				hostname: await hostnameFor(drain.serverId),
			});

			try {
				await run(drain.serverId, buildDeployLogDrainCommand(config));
				await db
					.update(logDrain)
					.set({ status: "running", statusMessage: null })
					.where(eq(logDrain.logDrainId, drain.logDrainId));
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Failed to start the shipper";
				await db
					.update(logDrain)
					.set({ status: "error", statusMessage: message })
					.where(eq(logDrain.logDrainId, drain.logDrainId));
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `log-drain:${drain.name}:deploy`,
			});
			return true;
		}),

	stop: adminProcedure
		.input(apiFindOneLogDrain)
		.mutation(async ({ input, ctx }) => {
			const drain = await findDrain(input.logDrainId, ctx);
			await run(drain.serverId, buildRemoveLogDrainCommand());
			await db
				.update(logDrain)
				.set({ status: "stopped", statusMessage: null })
				.where(eq(logDrain.logDrainId, drain.logDrainId));
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `log-drain:${drain.name}:stop`,
			});
			return true;
		}),
});
