import {
	isFlagEnabled,
	setSetting,
} from "@dokploy/server/services/abhash/flags";
import {
	createScimConnection,
	listScimConnections,
	revokeScimConnection,
} from "@dokploy/server/services/abhash/scim/tokens";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const connectionId = z
	.string()
	.trim()
	.min(2)
	.max(40)
	.regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens");

export const abhashScimRouter = createTRPCRouter({
	status: adminProcedure.query(async ({ ctx }) => ({
		enabled: await isFlagEnabled("scim.enabled"),
		connections: await listScimConnections(ctx.session.activeOrganizationId),
	})),

	setEnabled: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			if (ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the organization owner can change this",
				});
			}
			await setSetting("scim.enabled", input.enabled, ctx.user.id);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "scim.enabled",
				metadata: input,
			});
			return true;
		}),

	/** Creates or rotates a connection; the token is returned only this once. */
	createToken: adminProcedure
		.input(z.object({ providerId: connectionId }))
		.mutation(async ({ ctx, input }) => {
			const token = await createScimConnection(
				ctx.session.activeOrganizationId,
				input.providerId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: `scim-connection:${input.providerId}`,
			});
			return { token };
		}),

	revoke: adminProcedure
		.input(z.object({ providerId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await revokeScimConnection(
				ctx.session.activeOrganizationId,
				input.providerId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: `scim-connection:${input.providerId}`,
			});
			return true;
		}),
});
