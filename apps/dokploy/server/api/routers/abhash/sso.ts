import { db } from "@dokploy/server/db";
import {
	abhashSsoGroupMapping,
	abhashSsoProvider,
	abhashTeam,
	ssoProvider,
} from "@dokploy/server/db/schema";
import {
	ENFORCE_SSO_OFF,
	type EnforceSso,
} from "@dokploy/server/services/abhash/auth-guard";
import {
	getSetting,
	isFlagEnabled,
	setSetting,
} from "@dokploy/server/services/abhash/flags";
import {
	authentikEndpoints,
	createProvider,
	deleteProvider,
	discover,
	listProviders,
	publicProviders,
	updateProvider,
} from "@dokploy/server/services/abhash/sso/providers";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter, publicProcedure } from "../../trpc";

const ownerOnly = (role: string) => {
	if (role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the organization owner can change this",
		});
	}
};

const domain = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
		"Not a domain",
	);

const providerInput = z.object({
	providerId: z
		.string()
		.trim()
		.min(2)
		.max(40)
		.regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens"),
	displayName: z.string().trim().min(1).max(60),
	kind: z.enum(["authentik", "generic"]),
	// Authentik: base URL + application slug. Generic: the discovery URL.
	authentikUrl: z.string().trim().optional(),
	authentikSlug: z.string().trim().optional(),
	discoveryUrl: z.string().trim().optional(),
	clientId: z.string().trim().min(1),
	clientSecret: z.string().optional(),
	scopes: z
		.array(z.string().trim().min(1))
		.default(["openid", "email", "profile"]),
	domains: z.array(domain).min(1, "Add at least one email domain"),
	groupsClaim: z.string().trim().min(1).default("groups"),
	trustForLinking: z.boolean().default(false),
	enabled: z.boolean().default(true),
	showOnLogin: z.boolean().default(true),
	jitEnabled: z.boolean().default(true),
	requireGroupMatch: z.boolean().default(false),
	defaultRole: z.string().trim().min(1).default("member"),
	maxRole: z.enum(["admin", "member"]).default("admin"),
});

/** Resolves the discovery URL (Authentik preset or explicit) and validates. */
const resolveProvider = (input: z.infer<typeof providerInput>) => {
	const discoveryUrl =
		input.kind === "authentik" && input.authentikUrl && input.authentikSlug
			? authentikEndpoints(input.authentikUrl, input.authentikSlug).discoveryUrl
			: input.discoveryUrl;
	if (!discoveryUrl) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				input.kind === "authentik"
					? "Enter the Authentik URL and the application slug"
					: "Enter the discovery URL",
		});
	}
	if (input.defaultRole === "owner") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "SSO cannot grant owner",
		});
	}
	return { ...input, discoveryUrl };
};

const mappingsRouter = createTRPCRouter({
	list: adminProcedure.query(({ ctx }) =>
		db.query.abhashSsoGroupMapping.findMany({
			where: eq(
				abhashSsoGroupMapping.organizationId,
				ctx.session.activeOrganizationId,
			),
			orderBy: (m, { desc }) => [desc(m.priority)],
		}),
	),

	create: adminProcedure
		.input(
			z
				.object({
					providerId: z.string().nullable(),
					groupName: z.string().trim().min(1).max(200),
					orgRole: z.string().trim().min(1).nullable(),
					teamId: z.string().nullable(),
					priority: z.number().int().min(0).max(1000).default(0),
				})
				.refine((m) => m.orgRole || m.teamId, {
					message: "Map the group to a role, a team, or both",
				})
				.refine((m) => m.orgRole !== "owner", {
					message: "SSO cannot grant owner",
				}),
		)
		.mutation(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			if (input.teamId) {
				const team = await db.query.abhashTeam.findFirst({
					where: and(
						eq(abhashTeam.id, input.teamId),
						eq(abhashTeam.organizationId, orgId),
					),
				});
				if (!team)
					throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
			}
			if (input.providerId) {
				const provider = await db.query.ssoProvider.findFirst({
					where: and(
						eq(ssoProvider.providerId, input.providerId),
						eq(ssoProvider.organizationId, orgId),
					),
				});
				if (!provider)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Provider not found",
					});
			}
			const [row] = await db
				.insert(abhashSsoGroupMapping)
				.values({ ...input, organizationId: orgId })
				.returning();
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: "sso-group-mapping",
				metadata: input,
			});
			return row;
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(abhashSsoGroupMapping)
				.where(
					and(
						eq(abhashSsoGroupMapping.id, input.id),
						eq(
							abhashSsoGroupMapping.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: "sso-group-mapping",
				resourceId: input.id,
			});
			return true;
		}),
});

export const abhashSsoRouter = createTRPCRouter({
	/** For the sign-in page; reveals only provider names. */
	publicConfig: publicProcedure.query(async () => {
		if (!(await isFlagEnabled("sso.enabled"))) {
			return { providers: [], enforced: false, allowPasskey: true };
		}
		const enforce = await getSetting<EnforceSso>(
			"sso.enforce",
			ENFORCE_SSO_OFF,
		);
		return {
			providers: await publicProviders(),
			enforced: enforce.enabled,
			allowPasskey: !enforce.enabled || enforce.allowPasskey,
		};
	}),

	status: adminProcedure.query(async () => ({
		enabled: await isFlagEnabled("sso.enabled"),
		enforce: await getSetting<EnforceSso>("sso.enforce", ENFORCE_SSO_OFF),
	})),

	setEnabled: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx.user.role);
			if (!input.enabled) {
				await setSetting("sso.enforce", ENFORCE_SSO_OFF, ctx.user.id);
			}
			await setSetting("sso.enabled", input.enabled, ctx.user.id);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "sso.enabled",
				metadata: input,
			});
			return true;
		}),

	setEnforce: adminProcedure
		.input(z.object({ enabled: z.boolean(), allowPasskey: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx.user.role);
			if (input.enabled) {
				if (!(await isFlagEnabled("sso.enabled"))) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Turn SSO on first",
					});
				}
				// Refuse to lock everyone into a provider nobody has signed in with.
				const [proven] = await db
					.select({ providerId: abhashSsoProvider.providerId })
					.from(abhashSsoProvider)
					.innerJoin(
						ssoProvider,
						eq(ssoProvider.providerId, abhashSsoProvider.providerId),
					)
					.where(
						and(
							eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
							eq(abhashSsoProvider.enabled, true),
							isNotNull(abhashSsoProvider.lastLoginAt),
						),
					)
					.limit(1);
				if (!proven) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Sign in once through an enabled provider before enforcing SSO, so you know it works",
					});
				}
			}
			await setSetting("sso.enforce", input, ctx.user.id);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "sso.enforce",
				metadata: input,
			});
			return true;
		}),

	providers: adminProcedure.query(({ ctx }) =>
		listProviders(ctx.session.activeOrganizationId),
	),

	testDiscovery: adminProcedure
		.input(
			z.object({
				kind: z.enum(["authentik", "generic"]),
				authentikUrl: z.string().optional(),
				authentikSlug: z.string().optional(),
				discoveryUrl: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const url =
				input.kind === "authentik" && input.authentikUrl && input.authentikSlug
					? authentikEndpoints(input.authentikUrl, input.authentikSlug)
							.discoveryUrl
					: input.discoveryUrl;
			if (!url)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Nothing to test",
				});
			const doc = await discover(url);
			return { discoveryUrl: url, issuer: doc.issuer };
		}),

	createProvider: adminProcedure
		.input(providerInput)
		.mutation(async ({ ctx, input: raw }) => {
			const input = resolveProvider(raw);
			await createProvider(
				ctx.session.activeOrganizationId,
				ctx.user.id,
				input,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: `sso-provider:${input.providerId}`,
				metadata: { ...input, clientSecret: undefined },
			});
			return true;
		}),

	updateProvider: adminProcedure
		.input(providerInput)
		.mutation(async ({ ctx, input: raw }) => {
			const input = resolveProvider(raw);
			await updateProvider(ctx.session.activeOrganizationId, input);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `sso-provider:${input.providerId}`,
				metadata: {
					...input,
					clientSecret: input.clientSecret ? "(changed)" : undefined,
				},
			});
			return true;
		}),

	deleteProvider: adminProcedure
		.input(z.object({ providerId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await deleteProvider(ctx.session.activeOrganizationId, input.providerId);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: `sso-provider:${input.providerId}`,
			});
			return true;
		}),

	mappings: mappingsRouter,
});
