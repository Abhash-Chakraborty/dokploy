import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../db";
import { abhashTraefikMiddleware } from "../../../db/schema";

export type MiddlewareRow = typeof abhashTraefikMiddleware.$inferSelect;

/**
 * Traefik's name for a middleware. Every organization's definitions share a
 * server's dynamic directory, so the name carries a short organization key
 * and one organization can never shadow another's middleware.
 */
export const traefikName = (organizationId: string, name: string) =>
	`abhash-${createHash("sha1").update(organizationId).digest("hex").slice(0, 8)}-${name}`;

/** Defined by the file provider, so every router references it with @file. */
export const middlewareRef = (
	row: Pick<MiddlewareRow, "organizationId" | "name">,
) => `${traefikName(row.organizationId, row.name)}@file`;

export const isManagedRef = (ref: string) =>
	/^abhash-[0-9a-f]{8}-[a-z0-9-]+@file$/.test(ref);

const live = (organizationId: string) =>
	db.query.abhashTraefikMiddleware.findMany({
		where: and(
			eq(abhashTraefikMiddleware.organizationId, organizationId),
			eq(abhashTraefikMiddleware.enabled, true),
			isNull(abhashTraefikMiddleware.deletedAt),
		),
		orderBy: (row, { asc }) => [asc(row.createdAt)],
	});

/** The middlewares a router in this project picks up without being asked. */
export const scopedMiddlewareRefs = async (project: {
	organizationId: string;
	projectId: string;
}) =>
	(await live(project.organizationId))
		.filter(
			(row) =>
				row.scope === "all" ||
				(row.scope === "projects" &&
					row.projectIds.includes(project.projectId)),
		)
		.map(middlewareRef);

export const dashboardMiddlewareRefs = async () =>
	(
		await db.query.abhashTraefikMiddleware.findMany({
			where: and(
				eq(abhashTraefikMiddleware.enabled, true),
				eq(abhashTraefikMiddleware.applyToDashboard, true),
				isNull(abhashTraefikMiddleware.deletedAt),
			),
			orderBy: (row, { asc }) => [asc(row.createdAt)],
		})
	).map(middlewareRef);

/**
 * Stands in for a deleted or disabled middleware, so a router that still
 * names it keeps routing. Traefik refuses an empty `headers: {}` (and one
 * refused file stops every file on that server from reloading), so this
 * strips a header nobody sends instead.
 */
export const NOOP_MIDDLEWARE = {
	headers: { customRequestHeaders: { "X-Dokploy-Middleware-Off": "" } },
};

/** The fields Traefik v3 knows per middleware; anything else fails the file. */
const TRAEFIK_FIELDS: Record<string, string[] | null> = {
	addPrefix: ["prefix"],
	basicAuth: ["users", "usersFile", "realm", "removeHeader", "headerField"],
	buffering: [
		"maxRequestBodyBytes",
		"memRequestBodyBytes",
		"maxResponseBodyBytes",
		"memResponseBodyBytes",
		"retryExpression",
	],
	chain: ["middlewares"],
	circuitBreaker: [
		"expression",
		"checkPeriod",
		"fallbackDuration",
		"recoveryDuration",
		"responseCode",
	],
	compress: [
		"excludedContentTypes",
		"includedContentTypes",
		"minResponseBodyBytes",
		"defaultEncoding",
		"encodings",
	],
	contentType: ["autoDetect"],
	digestAuth: ["users", "usersFile", "realm", "removeHeader", "headerField"],
	errors: ["status", "service", "query", "statusRewrites"],
	forwardAuth: [
		"address",
		"tls",
		"trustForwardHeader",
		"authResponseHeaders",
		"authResponseHeadersRegex",
		"authRequestHeaders",
		"addAuthCookiesToResponse",
		"headerField",
		"forwardBody",
		"maxBodySize",
		"preserveLocationHeader",
		"preserveRequestMethod",
	],
	grpcWeb: ["allowOrigins"],
	headers: [
		"customRequestHeaders",
		"customResponseHeaders",
		"accessControlAllowCredentials",
		"accessControlAllowHeaders",
		"accessControlAllowMethods",
		"accessControlAllowOriginList",
		"accessControlAllowOriginListRegex",
		"accessControlExposeHeaders",
		"accessControlMaxAge",
		"addVaryHeader",
		"allowedHosts",
		"hostsProxyHeaders",
		"sslProxyHeaders",
		"stsSeconds",
		"stsIncludeSubdomains",
		"stsPreload",
		"forceSTSHeader",
		"frameDeny",
		"customFrameOptionsValue",
		"contentTypeNosniff",
		"browserXssFilter",
		"customBrowserXSSValue",
		"contentSecurityPolicy",
		"contentSecurityPolicyReportOnly",
		"publicKey",
		"referrerPolicy",
		"permissionsPolicy",
		"isDevelopment",
	],
	ipAllowList: ["sourceRange", "ipStrategy", "rejectStatusCode"],
	inFlightReq: ["amount", "sourceCriterion"],
	passTLSClientCert: ["pem", "info"],
	plugin: null,
	rateLimit: ["average", "period", "burst", "sourceCriterion", "redis"],
	redirectRegex: ["regex", "replacement", "permanent"],
	redirectScheme: ["scheme", "port", "permanent"],
	replacePath: ["path"],
	replacePathRegex: ["regex", "replacement"],
	retry: ["attempts", "initialInterval"],
	stripPrefix: ["prefixes", "forceSlash"],
	stripPrefixRegex: ["regex"],
};

const emptyMapAt = (value: unknown, at: string): string | null => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length === 0) return at;
	for (const [key, child] of entries) {
		const found = emptyMapAt(child, `${at}.${key}`);
		if (found) return found;
	}
	return null;
};

/**
 * Catches what would make Traefik refuse the whole file: an unknown
 * middleware or field, or an empty map. Returns why, or null when it is fine.
 */
export const checkCustomMiddleware = (definition: unknown): string | null => {
	if (
		!definition ||
		typeof definition !== "object" ||
		Array.isArray(definition) ||
		Object.keys(definition).length !== 1
	) {
		return "Write exactly one middleware, e.g. `ipAllowList:` with its options underneath";
	}
	const [type, options] = Object.entries(definition)[0] as [string, unknown];
	if (!(type in TRAEFIK_FIELDS)) {
		return `Traefik has no middleware called ${type}`;
	}
	if (type === "compress" && options && typeof options === "object") {
		if (Object.keys(options).length === 0) return null;
	}
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		return `${type} needs its options underneath`;
	}
	const known = TRAEFIK_FIELDS[type];
	const unknown = known
		? Object.keys(options).filter((field) => !known.includes(field))
		: [];
	if (unknown.length > 0) {
		return `${type} has no option ${unknown.join(", ")}`;
	}
	const empty = emptyMapAt(options, type);
	return empty
		? `${empty} is empty; Traefik refuses empty sections, so remove it`
		: null;
};

const withoutEmpty = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(
			([, v]) =>
				!(v && typeof v === "object" && Object.keys(v as object).length === 0),
		),
	);

/** The Traefik definition for one middleware. */
export const renderMiddleware = (
	row: Pick<MiddlewareRow, "kind" | "config" | "deletedAt" | "enabled">,
): Record<string, unknown> => {
	if (row.deletedAt || !row.enabled) return NOOP_MIDDLEWARE;
	const c = row.config as Record<string, unknown>;
	const list = (value: unknown) =>
		(Array.isArray(value) ? value : [])
			.map((item) => String(item).trim())
			.filter(Boolean);
	const record = (value: unknown) =>
		Object.fromEntries(
			Object.entries((value as Record<string, unknown>) ?? {}).map(
				([key, v]) => [key, String(v)],
			),
		);
	switch (row.kind) {
		case "rateLimit":
			return {
				rateLimit: {
					average: Number(c.average),
					burst: Number(c.burst),
					period: String(c.period ?? "1s"),
				},
			};
		case "ipAllowList":
			return {
				ipAllowList: {
					sourceRange: list(c.sourceRange),
					...(c.depth ? { ipStrategy: { depth: Number(c.depth) } } : {}),
				},
			};
		case "basicAuth":
			return {
				basicAuth: {
					users: list(c.users),
					removeHeader: true,
				},
			};
		case "securityHeaders":
			return {
				headers: {
					stsSeconds: Number(c.stsSeconds ?? 31536000),
					stsIncludeSubdomains: true,
					frameDeny: c.frameDeny !== false,
					contentTypeNosniff: c.contentTypeNosniff !== false,
					browserXssFilter: c.browserXssFilter !== false,
					referrerPolicy: String(
						c.referrerPolicy ?? "strict-origin-when-cross-origin",
					),
				},
			};
		case "headers": {
			const headers = withoutEmpty({
				customRequestHeaders: record(c.requestHeaders),
				customResponseHeaders: record(c.responseHeaders),
			});
			return Object.keys(headers).length ? { headers } : NOOP_MIDDLEWARE;
		}
		case "redirectRegex":
			return {
				redirectRegex: {
					regex: String(c.regex),
					replacement: String(c.replacement),
					permanent: c.permanent === true,
				},
			};
		case "compress":
			return { compress: {} };
		case "retry":
			return { retry: { attempts: Number(c.attempts ?? 3) } };
		case "inFlightReq":
			return { inFlightReq: { amount: Number(c.amount) } };
		case "buffering":
			return {
				buffering: { maxRequestBodyBytes: Number(c.maxRequestBodyBytes) },
			};
		case "stripPrefix":
			return { stripPrefix: { prefixes: list(c.prefixes) } };
		case "custom":
			return checkCustomMiddleware(c.definition) === null
				? (c.definition as Record<string, unknown>)
				: NOOP_MIDDLEWARE;
		default:
			return NOOP_MIDDLEWARE;
	}
};
