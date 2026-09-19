import { db } from "@dokploy/server/db";
import {
	abhashServerGroup,
	abhashServerMeta,
	server,
} from "@dokploy/server/db/schema";
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
