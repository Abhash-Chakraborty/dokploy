import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../../db";
import { abhashSsoProvider, ssoProvider } from "../../../db/schema";

type Discovery = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	userinfo_endpoint?: string;
	token_endpoint_auth_methods_supported?: string[];
};

const bad = (message: string) =>
	new TRPCError({ code: "BAD_REQUEST", message });

/** Issuer and discovery URL for an Authentik OAuth2/OpenID application. */
export const authentikEndpoints = (baseUrl: string, slug: string) => {
	const base = baseUrl.trim().replace(/\/+$/, "");
	const issuer = `${base}/application/o/${slug.trim()}/`;
	return { issuer, discoveryUrl: `${issuer}.well-known/openid-configuration` };
};

export const discoveryUrlFor = (issuer: string) =>
	`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

/** Fetches and validates an OpenID Connect discovery document. */
export const discover = async (discoveryUrl: string): Promise<Discovery> => {
	let url: URL;
	try {
		url = new URL(discoveryUrl);
	} catch {
		throw bad("The discovery URL is not a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw bad("The discovery URL must use http or https");
	}
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw bad(
			`Could not reach ${url.host}: ${error instanceof Error ? error.message : "request failed"}`,
		);
	}
	if (!response.ok) {
		throw bad(`Discovery returned HTTP ${response.status} from ${url.href}`);
	}
	const doc = (await response.json().catch(() => null)) as Discovery | null;
	for (const field of [
		"issuer",
		"authorization_endpoint",
		"token_endpoint",
		"jwks_uri",
	] as const) {
		if (!doc || typeof doc[field] !== "string") {
			throw bad(`The discovery document has no ${field}`);
		}
	}
	return doc as Discovery;
};

export type ProviderInput = {
	providerId: string;
	displayName: string;
	kind: "authentik" | "generic";
	discoveryUrl: string;
	clientId: string;
	clientSecret?: string;
	scopes: string[];
	domains: string[];
	groupsClaim: string;
	trustForLinking: boolean;
	enabled: boolean;
	showOnLogin: boolean;
	jitEnabled: boolean;
	requireGroupMatch: boolean;
	defaultRole: string;
	maxRole: "admin" | "member";
};

const oidcConfigFor = (
	doc: Discovery,
	input: ProviderInput,
	clientSecret: string,
) =>
	JSON.stringify({
		issuer: doc.issuer,
		pkce: true,
		clientId: input.clientId,
		clientSecret,
		discoveryEndpoint: input.discoveryUrl,
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
		jwksEndpoint: doc.jwks_uri,
		userInfoEndpoint: doc.userinfo_endpoint,
		tokenEndpointAuthentication:
			doc.token_endpoint_auth_methods_supported?.includes(
				"client_secret_basic",
			) === false &&
			doc.token_endpoint_auth_methods_supported.includes("client_secret_post")
				? "client_secret_post"
				: "client_secret_basic",
		scopes: input.scopes,
		mapping: {
			id: "sub",
			email: "email",
			name: "name",
			image: "picture",
			extraFields: { groups: input.groupsClaim },
		},
	});

const settingsFor = (input: ProviderInput) => ({
	displayName: input.displayName,
	kind: input.kind,
	enabled: input.enabled,
	showOnLogin: input.showOnLogin,
	jitEnabled: input.jitEnabled,
	requireGroupMatch: input.requireGroupMatch,
	groupsClaim: input.groupsClaim,
	defaultRole: input.defaultRole,
	maxRole: input.maxRole,
});

export const createProvider = async (
	organizationId: string,
	actorId: string,
	input: ProviderInput,
) => {
	if (!input.clientSecret) throw bad("A client secret is required");
	const existing = await db.query.ssoProvider.findFirst({
		where: eq(ssoProvider.providerId, input.providerId),
	});
	if (existing) throw bad(`Provider id "${input.providerId}" is taken`);
	const doc = await discover(input.discoveryUrl);
	await db.transaction(async (tx) => {
		await tx.insert(ssoProvider).values({
			id: nanoid(),
			providerId: input.providerId,
			issuer: doc.issuer,
			oidcConfig: oidcConfigFor(doc, input, input.clientSecret as string),
			userId: actorId,
			organizationId,
			domain: input.domains.join(","),
			// The plugin links an SSO login to an existing account when this is set
			// and the email domain matches. The column defaults to true, so it is
			// always written explicitly.
			domainVerified: input.trustForLinking,
		});
		await tx
			.insert(abhashSsoProvider)
			.values({ providerId: input.providerId, ...settingsFor(input) });
	});
	invalidateSsoOrigins();
};

const findOwned = async (organizationId: string, providerId: string) => {
	const row = await db.query.ssoProvider.findFirst({
		where: and(
			eq(ssoProvider.providerId, providerId),
			eq(ssoProvider.organizationId, organizationId),
		),
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Provider not found" });
	return row;
};

export const updateProvider = async (
	organizationId: string,
	input: ProviderInput,
) => {
	const row = await findOwned(organizationId, input.providerId);
	const previous = JSON.parse(row.oidcConfig ?? "{}") as {
		clientSecret?: string;
	};
	const secret = input.clientSecret || previous.clientSecret;
	if (!secret) throw bad("A client secret is required");
	const doc = await discover(input.discoveryUrl);
	await db.transaction(async (tx) => {
		await tx
			.update(ssoProvider)
			.set({
				issuer: doc.issuer,
				oidcConfig: oidcConfigFor(doc, input, secret),
				domain: input.domains.join(","),
				domainVerified: input.trustForLinking,
			})
			.where(eq(ssoProvider.providerId, input.providerId));
		await tx
			.insert(abhashSsoProvider)
			.values({ providerId: input.providerId, ...settingsFor(input) })
			.onConflictDoUpdate({
				target: abhashSsoProvider.providerId,
				set: settingsFor(input),
			});
	});
	invalidateSsoOrigins();
};

export const deleteProvider = async (
	organizationId: string,
	providerId: string,
) => {
	await findOwned(organizationId, providerId);
	await db.delete(ssoProvider).where(eq(ssoProvider.providerId, providerId));
	invalidateSsoOrigins();
};

/** Providers of an organization for the admin UI; the client secret never leaves the server. */
export const listProviders = async (organizationId: string) => {
	const rows = await db.query.ssoProvider.findMany({
		where: eq(ssoProvider.organizationId, organizationId),
	});
	const settings = await db.query.abhashSsoProvider.findMany();
	return rows.map((row) => {
		const config = JSON.parse(row.oidcConfig ?? "{}") as {
			clientId?: string;
			clientSecret?: string;
			discoveryEndpoint?: string;
			scopes?: string[];
			mapping?: { extraFields?: { groups?: string } };
		};
		const s = settings.find((x) => x.providerId === row.providerId);
		return {
			providerId: row.providerId,
			issuer: row.issuer,
			domains: row.domain.split(",").filter(Boolean),
			trustForLinking: row.domainVerified,
			clientId: config.clientId ?? "",
			hasClientSecret: !!config.clientSecret,
			discoveryUrl: config.discoveryEndpoint ?? "",
			scopes: config.scopes ?? [],
			displayName: s?.displayName ?? row.providerId,
			kind: s?.kind ?? "generic",
			enabled: s?.enabled ?? false,
			showOnLogin: s?.showOnLogin ?? true,
			jitEnabled: s?.jitEnabled ?? true,
			requireGroupMatch: s?.requireGroupMatch ?? false,
			groupsClaim: s?.groupsClaim ?? "groups",
			defaultRole: s?.defaultRole ?? "member",
			maxRole: (s?.maxRole ?? "admin") as "admin" | "member",
			lastLoginAt: s?.lastLoginAt ?? null,
		};
	});
};

/** Buttons for the sign-in page: enabled providers only, nothing sensitive. */
export const publicProviders = async () => {
	const rows = await db.query.abhashSsoProvider.findMany({
		where: and(
			eq(abhashSsoProvider.enabled, true),
			eq(abhashSsoProvider.showOnLogin, true),
		),
		columns: { providerId: true, displayName: true, kind: true },
	});
	return rows;
};

export const getProviderSettings = (providerId: string) =>
	db.query.abhashSsoProvider.findFirst({
		where: eq(abhashSsoProvider.providerId, providerId),
	});

// Shared across route bundles; see the note in ../flags.ts.
const originsShared = globalThis as unknown as {
	__abhashSsoOrigins?: { value: string[]; expiresAt: number } | null;
};

/**
 * Origins of enabled providers' endpoints. Better Auth refuses IdP endpoints
 * on private addresses (an SSRF guard) unless their origin is trusted; an
 * admin-configured Authentik on the LAN or the same host is exactly that.
 */
export const ssoTrustedOrigins = async (): Promise<string[]> => {
	const originsCache = originsShared.__abhashSsoOrigins;
	if (originsCache && originsCache.expiresAt > Date.now())
		return originsCache.value;
	const enabled = await db
		.select({ oidcConfig: ssoProvider.oidcConfig, issuer: ssoProvider.issuer })
		.from(ssoProvider)
		.innerJoin(
			abhashSsoProvider,
			eq(abhashSsoProvider.providerId, ssoProvider.providerId),
		)
		.where(eq(abhashSsoProvider.enabled, true));
	const origins = new Set<string>();
	for (const row of enabled) {
		const config = JSON.parse(row.oidcConfig ?? "{}") as Record<
			string,
			unknown
		>;
		for (const value of [
			row.issuer,
			config.discoveryEndpoint,
			config.authorizationEndpoint,
			config.tokenEndpoint,
			config.jwksEndpoint,
			config.userInfoEndpoint,
		]) {
			if (typeof value !== "string") continue;
			try {
				origins.add(new URL(value).origin);
			} catch {}
		}
	}
	const value = [...origins];
	originsShared.__abhashSsoOrigins = { value, expiresAt: Date.now() + 10_000 };
	return value;
};

export const invalidateSsoOrigins = () => {
	originsShared.__abhashSsoOrigins = null;
};
