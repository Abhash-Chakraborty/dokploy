import { db } from "@dokploy/server/db";
import {
	abhashServerGroup,
	abhashServerMeta,
	server,
} from "@dokploy/server/db/schema";
import { enqueueJobForActor } from "@dokploy/server/services/abhash/agents";
import { enqueueJob } from "@dokploy/server/services/abhash/jobs";
import {
	closeConnection,
	collectFacts,
	ensureMeta,
} from "@dokploy/server/services/abhash/ssh";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const ownServer = async (organizationId: string, serverId: string) => {
	const row = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
		),
		columns: { serverId: true, name: true },
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	return row;
};

export const abhashFleetRouter = createTRPCRouter({
	list: adminProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const servers = await db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			orderBy: [asc(server.name)],
			columns: {
				serverId: true,
				name: true,
				ipAddress: true,
				port: true,
				username: true,
				serverType: true,
				serverStatus: true,
			},
		});
		const meta = await db.query.abhashServerMeta.findMany({
			where: eq(abhashServerMeta.organizationId, organizationId),
		});
		const groups = await db.query.abhashServerGroup.findMany({
			where: eq(abhashServerGroup.organizationId, organizationId),
			orderBy: [asc(abhashServerGroup.name)],
		});
		const byServer = new Map(meta.map((row) => [row.serverId, row]));
		return {
			groups,
			servers: servers.map((row) => ({
				...row,
				meta: byServer.get(row.serverId) ?? null,
			})),
		};
	}),

	setMeta: adminProcedure
		.input(
			z.object({
				serverId: z.string(),
				tags: z.array(z.string().trim().min(1).max(40)).optional(),
				groupId: z.string().nullable().optional(),
				environmentLabel: z.string().trim().max(40).nullable().optional(),
				connectVia: z.enum(["public", "mesh"]).optional(),
				maintenance: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await ownServer(organizationId, input.serverId);
			await ensureMeta(input.serverId, organizationId);
			const { serverId, ...values } = input;
			await db
				.update(abhashServerMeta)
				.set({ ...values, updatedAt: new Date() })
				.where(eq(abhashServerMeta.serverId, serverId));
			// A changed address means the pooled connection is stale.
			if (values.connectVia) closeConnection(serverId);
			await audit(ctx, {
				action: "update",
				resourceType: "server",
				resourceId: serverId,
				resourceName: target.name,
				metadata: values,
			});
			return true;
		}),

	/** Accepts a changed host key, after a person has checked why it changed. */
	acceptHostKey: adminProcedure
		.input(z.object({ serverId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await ownServer(organizationId, input.serverId);
			await db
				.update(abhashServerMeta)
				.set({ hostKey: null, hostKeyMismatch: false, updatedAt: new Date() })
				.where(eq(abhashServerMeta.serverId, input.serverId));
			closeConnection(input.serverId);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceId: input.serverId,
				resourceName: `host key accepted: ${target.name}`,
			});
			return true;
		}),

	refresh: adminProcedure
		.input(z.object({ serverId: z.string().optional() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.serverId) {
				await ownServer(organizationId, input.serverId);
				return collectFacts(input.serverId, organizationId);
			}
			const job = await enqueueJob(
				"fleet.collect-facts",
				{ organizationId },
				{
					actor: { type: "user", id: ctx.user.id, name: ctx.user.email },
					organizationId,
				},
			);
			return { jobId: job.id };
		}),

	/** Bootstrap, patch, clean up or run a command; all of them are jobs. */
	run: adminProcedure
		.input(
			z.discriminatedUnion("action", [
				z.object({
					action: z.literal("bootstrap"),
					serverId: z.string(),
					baseline: z.boolean().default(true),
					hardenSsh: z.boolean().default(true),
					installDocker: z.boolean().default(true),
				}),
				z.object({
					action: z.literal("exec"),
					serverIds: z.array(z.string()).min(1),
					command: z.string().min(1).max(8_000),
					mode: z.enum(["parallel", "rolling", "serial"]).default("rolling"),
					batchSize: z.number().int().min(1).max(50).default(5),
					stopOnFailure: z.boolean().default(true),
				}),
				z.object({
					action: z.literal("patch"),
					serverIds: z.array(z.string()).min(1),
					batchSize: z.number().int().min(1).max(20).default(1),
					reboot: z.boolean().default(true),
				}),
				z.object({
					action: z.literal("cleanup"),
					serverIds: z.array(z.string()).min(1),
					olderThanHours: z.number().int().min(1).max(8760).default(168),
					pruneVolumes: z.boolean().default(false),
				}),
			]),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { action, ...rest } = input;
			const ids =
				"serverIds" in rest
					? rest.serverIds
					: [(rest as { serverId: string }).serverId];
			for (const id of ids) await ownServer(organizationId, id);
			const type = `fleet.${action}` as const;
			try {
				const queued = await enqueueJobForActor(
					type,
					{ organizationId, ...rest },
					{
						actor: ctx.actor ?? {
							type: "user",
							id: ctx.user.id,
							name: ctx.user.email,
						},
						organizationId,
					},
				);
				await audit(ctx, {
					action: "run",
					resourceType: "server",
					resourceName: type,
					metadata: {
						servers: ids.length,
						approval: !!queued.approval,
						...("command" in rest ? { command: rest.command } : {}),
					},
				});
				return {
					jobId: queued.job?.id ?? null,
					approvalId: queued.approval?.id ?? null,
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}),

	groups: createTRPCRouter({
		create: adminProcedure
			.input(
				z.object({
					name: z.string().trim().min(1).max(60),
					description: z.string().trim().max(300).default(""),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const [row] = await db
					.insert(abhashServerGroup)
					.values({
						...input,
						organizationId: ctx.session.activeOrganizationId,
					})
					.returning();
				await audit(ctx, {
					action: "create",
					resourceType: "server",
					resourceId: row?.id,
					resourceName: `group ${input.name}`,
				});
				return row;
			}),

		remove: adminProcedure
			.input(z.object({ id: z.string() }))
			.mutation(async ({ ctx, input }) => {
				await db
					.delete(abhashServerGroup)
					.where(
						and(
							eq(abhashServerGroup.id, input.id),
							eq(
								abhashServerGroup.organizationId,
								ctx.session.activeOrganizationId,
							),
						),
					);
				await audit(ctx, {
					action: "delete",
					resourceType: "server",
					resourceId: input.id,
					resourceName: "server group",
				});
				return true;
			}),
	}),
});
