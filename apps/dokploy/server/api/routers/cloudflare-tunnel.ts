import {
	buildCloudflareTunnelStatusCommand,
	buildDeployCloudflareTunnelCommand,
	buildRemoveCloudflareTunnelCommand,
	execAsync,
	execAsyncRemote,
	findServerById,
	parseCloudflareTunnelStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	apiCreateCloudflareTunnel,
	apiFindOneCloudflareTunnel,
	apiUpdateCloudflareTunnel,
	cloudflareTunnel,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../trpc";

type Ctx = { session: { activeOrganizationId: string } };

const findTunnel = async (cloudflareTunnelId: string, ctx: Ctx) => {
	const tunnel = await db.query.cloudflareTunnel.findFirst({
		where: and(
			eq(cloudflareTunnel.cloudflareTunnelId, cloudflareTunnelId),
			eq(cloudflareTunnel.organizationId, ctx.session.activeOrganizationId),
		),
	});
	if (!tunnel) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Tunnel not found" });
	}
	return tunnel;
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

/** The token is write-only: it can be set and replaced, never read back. */
const withoutToken = <T extends { token: string }>(row: T) => {
	const { token: _token, ...rest } = row;
	return { ...rest, hasToken: true };
};

export const cloudflareTunnelRouter = createTRPCRouter({
	all: adminProcedure.query(async ({ ctx }) => {
		const tunnels = await db.query.cloudflareTunnel.findMany({
			where: eq(
				cloudflareTunnel.organizationId,
				ctx.session.activeOrganizationId,
			),
		});
		return tunnels.map(withoutToken);
	}),

	create: adminProcedure
		.input(apiCreateCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrg(input.serverId, ctx);
			const [created] = await db
				.insert(cloudflareTunnel)
				.values({
					name: input.name,
					token: input.token,
					serverId: input.serverId ?? null,
					organizationId: ctx.session.activeOrganizationId,
				})
				.returning();

			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceName: `cloudflare-tunnel:${input.name}`,
			});
			return created ? withoutToken(created) : null;
		}),

	update: adminProcedure
		.input(apiUpdateCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			const existing = await findTunnel(input.cloudflareTunnelId, ctx);
			await assertServerInOrg(input.serverId ?? existing.serverId, ctx);

			const [updated] = await db
				.update(cloudflareTunnel)
				.set({
					...(input.name ? { name: input.name } : {}),
					...(input.token ? { token: input.token } : {}),
					...(input.serverId === undefined
						? {}
						: { serverId: input.serverId ?? null }),
				})
				.where(
					eq(cloudflareTunnel.cloudflareTunnelId, input.cloudflareTunnelId),
				)
				.returning();

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `cloudflare-tunnel:${updated?.name ?? input.cloudflareTunnelId}`,
			});
			return updated ? withoutToken(updated) : null;
		}),

	remove: adminProcedure
		.input(apiFindOneCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			const tunnel = await findTunnel(input.cloudflareTunnelId, ctx);
			try {
				await run(tunnel.serverId, buildRemoveCloudflareTunnelCommand());
			} catch (error) {
				// An unreachable host shouldn't block removing the record.
				console.warn(
					"Could not stop the connector while deleting the tunnel:",
					error instanceof Error ? error.message : error,
				);
			}
			await db
				.delete(cloudflareTunnel)
				.where(
					eq(cloudflareTunnel.cloudflareTunnelId, tunnel.cloudflareTunnelId),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: `cloudflare-tunnel:${tunnel.name}`,
			});
			return true;
		}),

	deploy: adminProcedure
		.input(apiFindOneCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			const tunnel = await findTunnel(input.cloudflareTunnelId, ctx);
			try {
				await run(
					tunnel.serverId,
					buildDeployCloudflareTunnelCommand(tunnel.token),
				);
				await db
					.update(cloudflareTunnel)
					.set({ status: "running", statusMessage: null })
					.where(
						eq(cloudflareTunnel.cloudflareTunnelId, tunnel.cloudflareTunnelId),
					);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Failed to start the connector";
				await db
					.update(cloudflareTunnel)
					.set({ status: "error", statusMessage: message })
					.where(
						eq(cloudflareTunnel.cloudflareTunnelId, tunnel.cloudflareTunnelId),
					);
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `cloudflare-tunnel:${tunnel.name}:deploy`,
			});
			return true;
		}),

	stop: adminProcedure
		.input(apiFindOneCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			const tunnel = await findTunnel(input.cloudflareTunnelId, ctx);
			await run(tunnel.serverId, buildRemoveCloudflareTunnelCommand());
			await db
				.update(cloudflareTunnel)
				.set({ status: "stopped", statusMessage: null })
				.where(
					eq(cloudflareTunnel.cloudflareTunnelId, tunnel.cloudflareTunnelId),
				);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `cloudflare-tunnel:${tunnel.name}:stop`,
			});
			return true;
		}),

	/**
	 * Whether the edge actually accepted the connector. A running container
	 * with zero registered connections is the signature of a bad token, and is
	 * otherwise invisible.
	 */
	status: adminProcedure
		.input(apiFindOneCloudflareTunnel)
		.mutation(async ({ input, ctx }) => {
			const tunnel = await findTunnel(input.cloudflareTunnelId, ctx);
			try {
				const { stdout } = await run(
					tunnel.serverId,
					buildCloudflareTunnelStatusCommand(),
				);
				const status = parseCloudflareTunnelStatus(stdout);
				await db
					.update(cloudflareTunnel)
					.set({
						status: status.connections > 0 ? "running" : "error",
						statusMessage: status.connections > 0 ? null : status.detail,
					})
					.where(
						eq(cloudflareTunnel.cloudflareTunnelId, tunnel.cloudflareTunnelId),
					);
				return status;
			} catch (error) {
				return {
					running: false,
					connections: 0,
					detail:
						error instanceof Error
							? error.message
							: "Could not reach the host to check the connector.",
				};
			}
		}),
});
