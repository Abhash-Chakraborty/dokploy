import { sso } from "@better-auth/sso";
import { ssoWithDomainVerified } from "@dokploy/server/lib/sso-plugin";
import { normalizePrivateKey } from "@dokploy/server/utils/filesystem/ssh";
import { describe, expect, it } from "vitest";

type PluginSchema = {
	schema?: {
		ssoProvider?: {
			fields?: Record<string, { type: string; required: boolean }>;
		};
	};
};

const fieldsOf = (plugin: unknown) =>
	(plugin as PluginSchema).schema?.ssoProvider?.fields ?? {};

describe("sso account linking", () => {
	it("leaves domainVerified undeclared upstream, which is the bug", () => {
		expect(fieldsOf(sso({})).domainVerified).toBeUndefined();
	});

	it("declares domainVerified so the adapter returns the column", () => {
		expect(fieldsOf(ssoWithDomainVerified({})).domainVerified).toEqual({
			type: "boolean",
			required: false,
		});
	});

	it("keeps the rest of the model intact", () => {
		const fields = fieldsOf(ssoWithDomainVerified({}));
		for (const key of ["issuer", "domain", "providerId", "oidcConfig"]) {
			expect(fields[key]).toBeDefined();
		}
	});

	it("does not enable the plugin's own domain verification", () => {
		// That would refuse sign-in outright for an unverified provider.
		const plugin = ssoWithDomainVerified({}) as unknown as {
			options?: { domainVerification?: { enabled?: boolean } };
		};
		expect(plugin.options?.domainVerification?.enabled).toBeFalsy();
	});
});

describe("normalizePrivateKey", () => {
	const body =
		"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";

	it("appends the final newline OpenSSH requires", () => {
		expect(normalizePrivateKey(body)).toBe(`${body}\n`);
	});

	it("leaves a well-formed key alone", () => {
		expect(normalizePrivateKey(`${body}\n`)).toBe(`${body}\n`);
	});

	it("collapses CRLF endings", () => {
		expect(normalizePrivateKey(body.replace(/\n/g, "\r\n"))).toBe(`${body}\n`);
	});

	it("strips surrounding whitespace from a pasted key", () => {
		expect(normalizePrivateKey(`  \n${body}\n\n  `)).toBe(`${body}\n`);
	});

	it("is idempotent", () => {
		const once = normalizePrivateKey(body);
		expect(normalizePrivateKey(once)).toBe(once);
	});
});
