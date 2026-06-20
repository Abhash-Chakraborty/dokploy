import { normalizeTrustedOrigin } from "@dokploy/server";
import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { ssoProvider, user } from "@dokploy/server/db/schema";
import { ssoProviderBodySchema } from "@dokploy/server/db/schema/sso";
import {
	getOrganizationOwnerId,
	requestToHeaders,
} from "@dokploy/server/index";
import { auth } from "@dokploy/server/lib/auth";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	publicProcedure,
} from "@/server/api/trpc";

const providerInput = ssoProviderBodySchema.extend({
	overrideUserInfo: z.boolean().default(false).optional(),
});

const requireOwner = (role: string) => {
	if (role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the owner can manage SSO settings",
		});
	}
};

const providerColumns = {
	id: true,
	providerId: true,
	issuer: true,
	domain: true,
	oidcConfig: true,
	samlConfig: true,
	organizationId: true,
} as const;

async function assertDomainsAvailable(
	domains: string[],
	currentProviderId?: string,
) {
	const providers = await db.query.ssoProvider.findMany({
		columns: { providerId: true, domain: true },
	});

	for (const provider of providers) {
		if (provider.providerId === currentProviderId) continue;
		const providerDomains = provider.domain
			.split(",")
			.map((domain) => domain.trim().toLowerCase());
		for (const domain of domains) {
			if (providerDomains.includes(domain)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Domain ${domain} is already registered for another SSO provider`,
				});
			}
		}
	}
}

export const abhashSsoRouter = createTRPCRouter({
	showSignInWithSSO: publicProcedure.query(async () => {
		if (IS_CLOUD) {
			return true;
		}
		const provider = await db.query.ssoProvider.findFirst({
			columns: { id: true },
		});
		return !!provider;
	}),

	enforceSSO: publicProcedure.query(async () => {
		if (IS_CLOUD) {
			return false;
		}
		const settings = await getWebServerSettings();
		return settings?.enforceSSO ?? false;
	}),

	listProviders: adminProcedure.query(async ({ ctx }) => {
		return await db.query.ssoProvider.findMany({
			where: eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
			columns: providerColumns,
			orderBy: [asc(ssoProvider.createdAt)],
		});
	}),

	one: adminProcedure
		.input(z.object({ providerId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const provider = await db.query.ssoProvider.findFirst({
				where: and(
					eq(ssoProvider.providerId, input.providerId),
					eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				),
				columns: providerColumns,
			});

			if (!provider) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			return provider;
		}),

	register: adminProcedure
		.input(providerInput)
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			await assertDomainsAvailable(input.domains);

			await auth.registerSSOProvider({
				body: {
					...input,
					organizationId: ctx.session.activeOrganizationId,
					domain: input.domains.join(","),
				},
				headers: requestToHeaders(ctx.req),
			});

			return { success: true };
		}),

	update: adminProcedure
		.input(providerInput)
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			const existing = await db.query.ssoProvider.findFirst({
				where: and(
					eq(ssoProvider.providerId, input.providerId),
					eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				),
				columns: { id: true, issuer: true },
			});

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			await assertDomainsAvailable(input.domains, input.providerId);

			await auth.updateSSOProvider({
				params: { providerId: input.providerId },
				body: {
					...input,
					domain: input.domains.join(","),
				},
				headers: requestToHeaders(ctx.req),
			});

			return { success: true };
		}),

	deleteProvider: adminProcedure
		.input(z.object({ providerId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			const [deleted] = await db
				.delete(ssoProvider)
				.where(
					and(
						eq(ssoProvider.providerId, input.providerId),
						eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
					),
				)
				.returning({ id: ssoProvider.id });

			if (!deleted) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			return { success: true };
		}),

	getTrustedOrigins: adminProcedure.query(async ({ ctx }) => {
		const ownerId = await getOrganizationOwnerId(
			ctx.session.activeOrganizationId,
		);
		if (!ownerId) return [];
		const ownerUser = await db.query.user.findFirst({
			where: eq(user.id, ownerId),
			columns: { trustedOrigins: true },
		});
		return ownerUser?.trustedOrigins ?? [];
	}),

	addTrustedOrigin: adminProcedure
		.input(z.object({ origin: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			const ownerId = await getOrganizationOwnerId(
				ctx.session.activeOrganizationId,
			);
			if (!ownerId) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Organization owner not found",
				});
			}
			const normalized = normalizeTrustedOrigin(input.origin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const next = Array.from(
				new Set([...(ownerUser?.trustedOrigins ?? []), normalized]),
			);
			await db
				.update(user)
				.set({ trustedOrigins: next })
				.where(eq(user.id, ownerId));
			return { success: true };
		}),

	removeTrustedOrigin: adminProcedure
		.input(z.object({ origin: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			const ownerId = await getOrganizationOwnerId(
				ctx.session.activeOrganizationId,
			);
			if (!ownerId) return { success: true };
			const normalized = normalizeTrustedOrigin(input.origin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const next = (ownerUser?.trustedOrigins ?? []).filter(
				(origin) => origin.toLowerCase() !== normalized.toLowerCase(),
			);
			await db
				.update(user)
				.set({ trustedOrigins: next })
				.where(eq(user.id, ownerId));
			return { success: true };
		}),

	updateTrustedOrigin: adminProcedure
		.input(
			z.object({
				oldOrigin: z.string().min(1),
				newOrigin: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			requireOwner(ctx.user.role);
			const ownerId = await getOrganizationOwnerId(
				ctx.session.activeOrganizationId,
			);
			if (!ownerId) return { success: true };
			const oldOrigin = normalizeTrustedOrigin(input.oldOrigin);
			const newOrigin = normalizeTrustedOrigin(input.newOrigin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const next = (ownerUser?.trustedOrigins ?? []).map((origin) =>
				origin.toLowerCase() === oldOrigin.toLowerCase() ? newOrigin : origin,
			);
			await db
				.update(user)
				.set({ trustedOrigins: next })
				.where(eq(user.id, ownerId));
			return { success: true };
		}),
});
