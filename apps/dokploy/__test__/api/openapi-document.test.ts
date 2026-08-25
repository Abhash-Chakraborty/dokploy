import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";

/**
 * Dokploy's trpc-openapi fork opts *every* procedure into the OpenAPI document
 * unless it sets `meta.openapi.enabled = false`. A single procedure with an
 * input the generator can't express therefore throws and takes the whole
 * document — and with it the /swagger page — down.
 *
 * For a query, each top-level input key becomes a GET query parameter and must
 * be a primitive (ZodString / ZodNumber / ZodBoolean / ZodBigInt / ZodDate).
 * Unions, literals and objects are not allowed there.
 */
describe("OpenAPI document", () => {
	it("generates for every procedure in the router", () => {
		expect(() =>
			generateOpenApiDocument(appRouter, {
				title: "Dokploy API",
				version: "0.0.0",
				baseUrl: "https://example.com/api",
			}),
		).not.toThrow();
	});

	it("emits paths", () => {
		const document = generateOpenApiDocument(appRouter, {
			title: "Dokploy API",
			version: "0.0.0",
			baseUrl: "https://example.com/api",
		});
		expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
	});
});
