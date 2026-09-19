import {
	AUTHENTIK_RESPONSE_HEADERS,
	authentikAddress,
	middlewareRef,
	renderForwardAuthConfig,
} from "@dokploy/server/services/abhash/forward-auth";
import { describe, expect, it } from "vitest";

const gate = (overrides: Record<string, unknown> = {}) =>
	({
		id: "g1",
		organizationId: "o1",
		name: "Authentik",
		slug: "authentik",
		kind: "authentik",
		baseUrl: "https://auth.example.com",
		address: "https://auth.example.com/outpost.goauthentik.io/auth/traefik",
		trustForwardHeader: true,
		authResponseHeaders: AUTHENTIK_RESPONSE_HEADERS,
		createdAt: new Date(),
		...overrides,
	}) as never;

describe("forward auth", () => {
	it("derives Authentik's outpost address", () => {
		expect(authentikAddress("https://auth.example.com///")).toBe(
			"https://auth.example.com/outpost.goauthentik.io/auth/traefik",
		);
	});

	it("names the middleware the way domains reference it", () => {
		expect(middlewareRef("authentik")).toBe("abhash-fa-authentik@file");
	});

	it("renders a capped forwardAuth middleware per gate", () => {
		const config = renderForwardAuthConfig([
			gate(),
			gate({
				slug: "proxy",
				address: "http://proxy:4180/auth",
				authResponseHeaders: [],
			}),
		]);
		expect(config.http.middlewares["abhash-fa-authentik"]).toEqual({
			forwardAuth: {
				address: "https://auth.example.com/outpost.goauthentik.io/auth/traefik",
				trustForwardHeader: true,
				maxResponseBodySize: 1_048_576,
				authResponseHeaders: AUTHENTIK_RESPONSE_HEADERS,
			},
		});
		expect(config.http.middlewares["abhash-fa-proxy"]).toEqual({
			forwardAuth: {
				address: "http://proxy:4180/auth",
				trustForwardHeader: true,
				maxResponseBodySize: 1_048_576,
			},
		});
	});
});
