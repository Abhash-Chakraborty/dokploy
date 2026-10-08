import {
	cacheRuleInput,
	ruleExpression,
} from "@dokploy/server/services/abhash/cloudflare-cache";
import { describe, expect, it } from "vitest";

const rule = (input: Partial<Parameters<typeof cacheRuleInput.parse>[0]>) =>
	cacheRuleInput.parse({ name: "r", mode: "cache", ...input });

describe("ruleExpression", () => {
	it("matches everything when no field is set", () => {
		expect(ruleExpression(rule({}))).toBe("true");
	});

	it("joins hosts, path prefix and extensions", () => {
		expect(
			ruleExpression(
				rule({
					hosts: ["App.example.com"],
					pathPrefix: "/_next/static/",
					extensions: [".JS", "css"],
				}),
			),
		).toBe(
			'http.host in {"app.example.com"} and starts_with(http.request.uri.path, "/_next/static/") and http.request.uri.path.extension in {"js" "css"}',
		);
	});

	it("turns wildcard hosts into suffix matches", () => {
		expect(
			ruleExpression(rule({ hosts: ["example.com", "*.example.com"] })),
		).toBe(
			'(http.host in {"example.com"} or ends_with(http.host, ".example.com"))',
		);
	});

	it("rejects input that could break out of the expression", () => {
		expect(() => rule({ pathPrefix: '/a" or true or "' })).toThrow();
		expect(() => rule({ hosts: ['a.com" or "'] })).toThrow();
		expect(() => rule({ extensions: ["js}"] })).toThrow();
	});
});
