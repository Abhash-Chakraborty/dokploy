import {
	checkCustomMiddleware,
	NOOP_MIDDLEWARE,
	renderMiddleware,
} from "@dokploy/server/services/abhash/middlewares/refs";
import { describe, expect, it } from "vitest";

// Traefik refuses a whole dynamic file over one empty map, and while any
// file is refused no file on that server reloads, so no rendering may
// produce one. `compress: {}` is the one empty section Traefik accepts.
const emptyMaps = (value: unknown, at = ""): string[] => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const entries = Object.entries(value);
	if (entries.length === 0) return at === ".compress" ? [] : [at];
	return entries.flatMap(([key, child]) => emptyMaps(child, `${at}.${key}`));
};

const render = (
	kind: string,
	config: Record<string, unknown>,
	enabled = true,
) => renderMiddleware({ kind, config, enabled, deletedAt: null });

const KINDS: Record<string, Record<string, unknown>> = {
	rateLimit: { average: 100, burst: 50, period: "1s" },
	ipAllowList: { sourceRange: ["10.0.0.0/8"] },
	basicAuth: { users: ["ops:$2b$10$hash"] },
	securityHeaders: {},
	headers: { requestHeaders: {}, responseHeaders: {} },
	redirectRegex: { regex: "^a", replacement: "b" },
	compress: {},
	retry: { attempts: 3 },
	inFlightReq: { amount: 10 },
	buffering: { maxRequestBodyBytes: 1000 },
	stripPrefix: { prefixes: ["/api"] },
	custom: { definition: { chain: { middlewares: [] } } },
};

describe("middleware rendering Traefik accepts", () => {
	for (const [kind, config] of Object.entries(KINDS)) {
		it(`${kind} has no empty section`, () => {
			expect(emptyMaps(render(kind, config))).toEqual([]);
		});
	}

	it("disabled, deleted and unknown ones become a no-op that still loads", () => {
		expect(render("rateLimit", KINDS.rateLimit ?? {}, false)).toEqual(
			NOOP_MIDDLEWARE,
		);
		expect(
			renderMiddleware({
				kind: "rateLimit",
				config: {},
				enabled: true,
				deletedAt: new Date(),
			}),
		).toEqual(NOOP_MIDDLEWARE);
		expect(render("nope", {})).toEqual(NOOP_MIDDLEWARE);
		expect(emptyMaps(NOOP_MIDDLEWARE)).toEqual([]);
	});

	it("keeps only the header lists that have entries", () => {
		expect(render("headers", { requestHeaders: { "X-A": "1" } })).toEqual({
			headers: { customRequestHeaders: { "X-A": "1" } },
		});
	});

	it("a custom definition stored before validation existed is not written", () => {
		expect(render("custom", { definition: { headers: {} } })).toEqual(
			NOOP_MIDDLEWARE,
		);
	});
});

describe("custom middleware checks", () => {
	it.each([
		[{ ipAllowList: { sourceRange: ["10.0.0.0/8"] } }],
		[{ compress: {} }],
		[{ plugin: { anything: { goes: 1 } } }],
		[{ headers: { customResponseHeaders: { "X-Robots-Tag": "noindex" } } }],
	])("accepts %j", (definition) => {
		expect(checkCustomMiddleware(definition)).toBeNull();
	});

	it.each([
		[{ a: {}, b: {} }, /exactly one/],
		[{ bogus: { a: 1 } }, /no middleware called bogus/],
		[{ rateLimit: { average: 1, bogus: 2 } }, /no option bogus/],
		[{ headers: {} }, /headers is empty/],
		[
			{ headers: { customRequestHeaders: {} } },
			/customRequestHeaders is empty/,
		],
		[{ retry: null }, /needs its options/],
	])("refuses %j", (definition, message) => {
		expect(checkCustomMiddleware(definition)).toMatch(message);
	});
});
