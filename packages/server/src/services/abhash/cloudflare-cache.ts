import { z } from "zod";
import { dnsFetch } from "../../utils/dns/types";

const API = "https://api.cloudflare.com/client/v4";
const CACHE_PHASE = "http_request_cache_settings";
// Rules this panel owns carry this prefix in their description; any other
// rule in the zone is shown read-only and never rewritten.
const OWNED_PREFIX = "dokploy:";

type Envelope<T> = {
	success: boolean;
	errors?: { code: number; message: string }[];
	result: T;
};

export class CloudflareError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// Cloudflare answers a token that lacks a permission with a bare
// "Authentication error"; say which permission the token needs instead.
const PERMISSION_HINTS: Record<string, string> = {
	settings: "Zone Settings: Edit",
	purge: "Cache Purge: Purge",
	rules: "Cache Rules: Edit",
	tiered: "Zone Settings: Edit",
};

const cf = async <T>(
	token: string,
	path: string,
	init: RequestInit & { need?: keyof typeof PERMISSION_HINTS } = {},
): Promise<T> => {
	const response = await dnsFetch(`${API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token.trim()}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	const body = (await response.json().catch(() => null)) as Envelope<T> | null;
	if (!response.ok || !body?.success) {
		const detail = body?.errors?.map((e) => e.message).join(", ");
		const denied =
			response.status === 403 ||
			body?.errors?.some((e) => e.code === 10000 || e.code === 9109);
		const hint =
			denied && init.need
				? ` Check that the API token is valid and has the "${PERMISSION_HINTS[init.need]}" permission for this zone.`
				: "";
		throw new CloudflareError(
			`Cloudflare: ${detail || `request failed (${response.status})`}.${hint}`,
			response.status,
		);
	}
	return body.result;
};

export const zoneSettingIds = [
	"development_mode",
	"cache_level",
	"browser_cache_ttl",
	"always_online",
	"early_hints",
	"http3",
	"0rtt",
] as const;
export type ZoneSettingId = (typeof zoneSettingIds)[number];

export const zoneSettingValue = z.union([z.string(), z.number()]);

export const getZoneCacheSettings = async (token: string, zoneId: string) => {
	const all = await cf<
		{ id: string; value: unknown; editable: boolean; time_remaining?: number }[]
	>(token, `/zones/${zoneId}/settings`, { need: "settings" });
	const settings = Object.fromEntries(
		all
			.filter((s) => (zoneSettingIds as readonly string[]).includes(s.id))
			.map((s) => [
				s.id,
				{
					value: s.value as string | number,
					editable: s.editable,
					timeRemaining: s.time_remaining,
				},
			]),
	) as Partial<
		Record<
			ZoneSettingId,
			{ value: string | number; editable: boolean; timeRemaining?: number }
		>
	>;
	const tiered = await cf<{ value: string }>(
		token,
		`/zones/${zoneId}/cache/tiered_cache_smart_topology_enable`,
		{ need: "tiered" },
	).catch(() => null);
	return { settings, smartTieredCache: tiered ? tiered.value === "on" : null };
};

export const updateZoneSetting = (
	token: string,
	zoneId: string,
	id: ZoneSettingId,
	value: string | number,
) =>
	cf(token, `/zones/${zoneId}/settings/${id}`, {
		method: "PATCH",
		body: JSON.stringify({ value }),
		need: "settings",
	});

export const setSmartTieredCache = (
	token: string,
	zoneId: string,
	enabled: boolean,
) =>
	cf(token, `/zones/${zoneId}/cache/tiered_cache_smart_topology_enable`, {
		method: "PATCH",
		body: JSON.stringify({ value: enabled ? "on" : "off" }),
		need: "tiered",
	});

export const purgeInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("everything") }),
	z.object({
		kind: z.enum(["files", "hosts", "prefixes"]),
		values: z.array(z.string().trim().min(1)).min(1).max(30),
	}),
]);

export const purgeZoneCache = (
	token: string,
	zoneId: string,
	input: z.infer<typeof purgeInput>,
) =>
	cf(token, `/zones/${zoneId}/purge_cache`, {
		method: "POST",
		body: JSON.stringify(
			input.kind === "everything"
				? { purge_everything: true }
				: { [input.kind]: input.values },
		),
		need: "purge",
	});

const hostPattern = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i;
const extensionPattern = /^[a-z0-9]{1,10}$/i;

export const cacheRuleInput = z.object({
	id: z.string().optional(),
	name: z.string().trim().min(1).max(80),
	hosts: z
		.array(z.string().trim().toLowerCase().regex(hostPattern, "Not a hostname"))
		.max(20)
		.default([]),
	pathPrefix: z
		.string()
		.trim()
		.regex(/^(\/[^"\\\s]*)?$/, "Start with / and leave out quotes and spaces")
		.default(""),
	extensions: z
		.array(
			z
				.string()
				.trim()
				.toLowerCase()
				.transform((ext) => ext.replace(/^\./, ""))
				.pipe(z.string().regex(extensionPattern, "Not a file extension")),
		)
		.max(40)
		.default([]),
	mode: z.enum(["cache", "bypass"]),
	// Seconds; null keeps whatever the origin's Cache-Control says.
	edgeTtl: z.number().int().min(1).max(31_536_000).nullable().default(null),
	browserTtl: z.number().int().min(1).max(31_536_000).nullable().default(null),
	enabled: z.boolean().default(true),
});
export type CacheRule = z.infer<typeof cacheRuleInput>;

const quoted = (values: string[]) =>
	`{${values.map((value) => `"${value}"`).join(" ")}}`;

export const ruleExpression = (rule: CacheRule) => {
	const parts: string[] = [];
	const exact = rule.hosts.filter((host) => !host.startsWith("*."));
	const wildcards = rule.hosts.filter((host) => host.startsWith("*."));
	const hostParts = [
		exact.length ? `http.host in ${quoted(exact)}` : null,
		...wildcards.map((host) => `ends_with(http.host, "${host.slice(1)}")`),
	].filter(Boolean);
	if (hostParts.length === 1) parts.push(hostParts[0] as string);
	if (hostParts.length > 1) parts.push(`(${hostParts.join(" or ")})`);
	if (rule.pathPrefix) {
		parts.push(`starts_with(http.request.uri.path, "${rule.pathPrefix}")`);
	}
	if (rule.extensions.length) {
		parts.push(`http.request.uri.path.extension in ${quoted(rule.extensions)}`);
	}
	return parts.length ? parts.join(" and ") : "true";
};

const ruleAction = (rule: CacheRule) =>
	rule.mode === "bypass"
		? { cache: false }
		: {
				cache: true,
				edge_ttl: rule.edgeTtl
					? { mode: "override_origin", default: rule.edgeTtl }
					: { mode: "respect_origin" },
				browser_ttl: rule.browserTtl
					? { mode: "override_origin", default: rule.browserTtl }
					: { mode: "respect_origin" },
			};

type CloudflareRule = {
	id: string;
	description?: string;
	expression: string;
	action: string;
	action_parameters?: Record<string, unknown>;
	enabled: boolean;
};

const toCloudflareRule = (rule: CacheRule) => {
	const { id: _id, enabled: _enabled, ...model } = rule;
	return {
		description: `${OWNED_PREFIX}${JSON.stringify(model)}`,
		expression: ruleExpression(rule),
		action: "set_cache_settings",
		action_parameters: ruleAction(rule),
		enabled: rule.enabled,
	};
};

const fromCloudflareRule = (rule: CloudflareRule) => {
	if (rule.description?.startsWith(OWNED_PREFIX)) {
		const parsed = cacheRuleInput.safeParse({
			...JSON.parse(rule.description.slice(OWNED_PREFIX.length) || "{}"),
			id: rule.id,
			enabled: rule.enabled,
		});
		if (parsed.success) return { owned: true as const, rule: parsed.data };
	}
	return {
		owned: false as const,
		rule: {
			id: rule.id,
			name: rule.description || "Rule made outside Dokploy",
			expression: rule.expression,
			enabled: rule.enabled,
		},
	};
};

const entrypoint = (zoneId: string) =>
	`/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`;

const readEntrypoint = async (token: string, zoneId: string) => {
	try {
		return await cf<{ id: string; rules?: CloudflareRule[] }>(
			token,
			entrypoint(zoneId),
			{ need: "rules" },
		);
	} catch (error) {
		// A zone that never had a cache rule has no entrypoint ruleset yet.
		if (error instanceof CloudflareError && error.status === 404) return null;
		throw error;
	}
};

export const listCacheRules = async (token: string, zoneId: string) => {
	const ruleset = await readEntrypoint(token, zoneId);
	const rules = (ruleset?.rules ?? []).map(fromCloudflareRule);
	return {
		owned: rules.flatMap((entry) => (entry.owned ? [entry.rule] : [])),
		foreign: rules.flatMap((entry) => (entry.owned ? [] : [entry.rule])),
	};
};

export const saveCacheRule = async (
	token: string,
	zoneId: string,
	rule: CacheRule,
) => {
	const body = JSON.stringify(toCloudflareRule(rule));
	const ruleset = await readEntrypoint(token, zoneId);
	if (!ruleset) {
		return cf(token, entrypoint(zoneId), {
			method: "PUT",
			body: JSON.stringify({ rules: [JSON.parse(body)] }),
			need: "rules",
		});
	}
	const existing = rule.id
		? ruleset.rules?.find((entry) => entry.id === rule.id)
		: undefined;
	if (rule.id && !existing?.description?.startsWith(OWNED_PREFIX)) {
		throw new CloudflareError(
			"That rule was made outside Dokploy; edit it in the Cloudflare dashboard.",
			409,
		);
	}
	// Later rules win in Cloudflare, so bypass rules go last: an API path
	// stays uncached even when a host-wide rule caches everything else.
	const position =
		rule.mode === "bypass" ? undefined : { position: { index: 1 } };
	return existing
		? cf(
				token,
				`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${existing.id}`,
				{
					method: "PATCH",
					body,
					need: "rules",
				},
			)
		: cf(token, `/zones/${zoneId}/rulesets/${ruleset.id}/rules`, {
				method: "POST",
				body: JSON.stringify({ ...JSON.parse(body), ...position }),
				need: "rules",
			});
};

export const deleteCacheRule = async (
	token: string,
	zoneId: string,
	ruleId: string,
) => {
	const ruleset = await readEntrypoint(token, zoneId);
	const existing = ruleset?.rules?.find((entry) => entry.id === ruleId);
	if (!ruleset || !existing) return;
	if (!existing.description?.startsWith(OWNED_PREFIX)) {
		throw new CloudflareError(
			"That rule was made outside Dokploy; delete it in the Cloudflare dashboard.",
			409,
		);
	}
	await cf(token, `/zones/${zoneId}/rulesets/${ruleset.id}/rules/${ruleId}`, {
		method: "DELETE",
		need: "rules",
	});
};
