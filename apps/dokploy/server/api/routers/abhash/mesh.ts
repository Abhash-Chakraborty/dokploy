import { db } from "@dokploy/server/db";
import {
	abhashMeshProvider,
	DEFAULT_MESH_SETTINGS,
	server,
} from "@dokploy/server/db/schema";
import { enqueueJobForActor } from "@dokploy/server/services/abhash/agents";
import {
	activeProvider,
	clientFor,
	detectMesh,
	findProvider,
	headscalePolicySnippet,
	listProviders,
	setActiveProvider,
	syncPeers,
} from "@dokploy/server/services/abhash/mesh";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

const settingsInput = z.object({
	groupPrefix: z
		.string()
		.trim()
		.min(2)
		.max(20)
		.regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens"),
	manageDns: z.boolean(),
	sshPort: z.number().int().min(1).max(65535),
	swarmOverMesh: z.boolean(),
});

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

export const abhashMeshRouter = createTRPCRouter({
	list: adminProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const providers = await listProviders(organizationId);
		const peers = await db.query.abhashServerMesh.findMany();
		const servers = await db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			columns: { serverId: true, name: true, ipAddress: true },
		});
		const byServer = new Map(peers.map((row) => [row.serverId, row]));
		return {
			providers,
			servers: servers.map((row) => ({
				...row,
				mesh: byServer.get(row.serverId) ?? null,
			})),
		};
	}),

	/**
	 * Reads the mesh client on each server directly. A fleet already joined by
	 * hand has no provider record here, so the provider API cannot see it.
	 */
	detect: adminProcedure.query(async ({ ctx }) =>
		detectMesh(ctx.session.activeOrganizationId),
	),

	save: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				kind: z.enum(["netbird", "headscale"]),
				name: z.string().trim().min(1).max(60),
				baseUrl: z.string().trim().url(),
				tokenRef: z
					.string()
					.trim()
					.regex(
						/^\$\{\{secret\.[A-Z][A-Z0-9_]*\}\}$/,
						"Point this at a vault secret, e.g. ${{secret.NETBIRD_TOKEN}}",
					),
				settings: settingsInput.default(DEFAULT_MESH_SETTINGS),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashMeshProvider)
						.set(values)
						.where(
							and(
								eq(abhashMeshProvider.id, id),
								eq(abhashMeshProvider.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashMeshProvider)
						.values({ ...values, organizationId, createdBy: ctx.user.id })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await audit(ctx, {
				action: id ? "update" : "create",
				resourceType: "security",
				resourceId: row.id,
				resourceName: `mesh ${row.name}`,
				metadata: { kind: row.kind, baseUrl: row.baseUrl },
			});
			return row;
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const provider = await findProvider(organizationId, input.id).catch(
				(error) => {
					throw asTrpc(error);
				},
			);
			if (provider.active) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Make another provider active first, or deactivate this one",
				});
			}
			await db
				.delete(abhashMeshProvider)
				.where(eq(abhashMeshProvider.id, provider.id));
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceId: provider.id,
				resourceName: `mesh ${provider.name}`,
			});
			return true;
		}),

	/** Only one provider can be active, so this is also how you switch. */
	setActive: adminProcedure
		.input(z.object({ id: z.string().nullable() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.id) await findProvider(organizationId, input.id);
			const active = await setActiveProvider(organizationId, input.id);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: "active mesh provider",
				metadata: { providerId: input.id },
			});
			return active ?? null;
		}),

	test: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const provider = await findProvider(
				ctx.session.activeOrganizationId,
				input.id,
			);
			try {
				const client = await clientFor(provider);
				return await client.test();
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	/** What Dokploy would create in the mesh, before it creates anything. */
	plan: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const provider = await findProvider(
				ctx.session.activeOrganizationId,
				input.id,
			);
			try {
				const client = await clientFor(provider);
				const plan = await client.ensurePolicy(true);
				return {
					plan,
					snippet:
						provider.kind === "headscale"
							? headscalePolicySnippet(
									provider.settings.groupPrefix,
									provider.settings.sshPort,
								)
							: null,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	sync: adminProcedure.mutation(async ({ ctx }) => {
		try {
			return await syncPeers(ctx.session.activeOrganizationId);
		} catch (error) {
			throw asTrpc(error);
		}
	}),

	join: adminProcedure
		.input(
			z.object({ serverId: z.string(), useForSsh: z.boolean().default(true) }),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await ownServer(organizationId, input.serverId);
			if (!(await activeProvider(organizationId))) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Turn on a mesh provider first",
				});
			}
			try {
				const queued = await enqueueJobForActor(
					"mesh.join",
					{ organizationId, ...input },
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
					resourceId: input.serverId,
					resourceName: `mesh join ${target.name}`,
					metadata: { approval: !!queued.approval },
				});
				return {
					jobId: queued.job?.id ?? null,
					approvalId: queued.approval?.id ?? null,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	leave: adminProcedure
		.input(z.object({ serverId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await ownServer(organizationId, input.serverId);
			try {
				const queued = await enqueueJobForActor(
					"mesh.leave",
					{ organizationId, serverId: input.serverId },
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
					resourceId: input.serverId,
					resourceName: `mesh leave ${target.name}`,
				});
				return {
					jobId: queued.job?.id ?? null,
					approvalId: queued.approval?.id ?? null,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),
});
