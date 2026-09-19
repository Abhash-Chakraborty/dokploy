import { db } from "@dokploy/server/db";
import { abhashForwardAuth } from "@dokploy/server/db/schema";
import {
	createGate,
	deleteGate,
	listGates,
	middlewareRef,
	syncForwardAuth,
	updateGate,
} from "@dokploy/server/services/abhash/forward-auth";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const gateFields = {
	name: z.string().trim().min(1).max(60),
	kind: z.enum(["authentik", "generic"]),
	baseUrl: z.string().trim().optional(),
	address: z.string().trim().optional(),
	trustForwardHeader: z.boolean().default(true),
	authResponseHeaders: z.array(z.string().trim().min(1)).optional(),
};

export const abhashForwardAuthRouter = createTRPCRouter({
	/** Just what the domain form needs to offer "Protect with SSO". */
	options: protectedProcedure.query(async ({ ctx }) => {
		const gates = await db.query.abhashForwardAuth.findMany({
			where: eq(
				abhashForwardAuth.organizationId,
				ctx.session.activeOrganizationId,
			),
			columns: { name: true, slug: true },
		});
		return gates.map((g) => ({
			name: g.name,
			middleware: middlewareRef(g.slug),
		}));
	}),

	list: adminProcedure.query(({ ctx }) =>
		listGates(ctx.session.activeOrganizationId),
	),

	create: adminProcedure
		.input(
			z.object({
				...gateFields,
				slug: z
					.string()
					.trim()
					.min(2)
					.max(40)
					.regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const results = await createGate(ctx.session.activeOrganizationId, input);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: `forward-auth:${input.slug}`,
				metadata: { ...input, sync: results },
			});
			return results;
		}),

	update: adminProcedure
		.input(z.object({ id: z.string(), ...gateFields }))
		.mutation(async ({ ctx, input }) => {
			const { id, ...rest } = input;
			const results = await updateGate(
				ctx.session.activeOrganizationId,
				id,
				rest,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `forward-auth:${id}`,
				metadata: { ...rest, sync: results },
			});
			return results;
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const results = await deleteGate(
				ctx.session.activeOrganizationId,
				input.id,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: `forward-auth:${input.id}`,
			});
			return results;
		}),

	/** Rewrites the middleware file on every server, e.g. after adding a server. */
	sync: adminProcedure.mutation(() => syncForwardAuth()),
});
