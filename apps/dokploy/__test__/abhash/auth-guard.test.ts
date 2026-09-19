import {
	isHttpBlockedPath,
	loginMethodForPath,
} from "@dokploy/server/services/abhash/auth-guard";
import { describe, expect, it } from "vitest";

describe("isHttpBlockedPath", () => {
	it.each([
		"/sso/register",
		"/sso/update-provider",
		"/sso/delete-provider",
		"/sso/providers",
		"/sso/callback/authentik",
		"/sso/saml2/sp/acs/authentik",
		"/sign-in/sso",
		"/scim/generate-token",
		"/scim/list-provider-connections",
		"/scim/delete-provider-connection",
		"/organization/create-role",
		"/organization/update-role",
		"/organization/delete-role",
		"/organization/update-member-role",
	])("blocks %s", (path) => {
		expect(isHttpBlockedPath(path)).toBe(true);
	});

	it.each([
		"/sign-in/email",
		"/sign-in/social",
		"/get-session",
		"/organization/accept-invitation",
		"/organization/cancel-invitation",
		"/organization/remove-member",
		"/organization/set-active",
		"/scim/v2/Users",
		"/passkey/generate-register-options",
	])("allows %s", (path) => {
		expect(isHttpBlockedPath(path)).toBe(false);
	});
});

describe("loginMethodForPath", () => {
	it.each([
		["/sign-in/email", undefined, "emailPassword"],
		["/sign-up/email", undefined, "emailPassword"],
		["/request-password-reset", undefined, "emailPassword"],
		["/forget-password", undefined, "emailPassword"],
		["/reset-password", undefined, "emailPassword"],
		["/reset-password/abc", undefined, "emailPassword"],
		["/sign-in/social", { provider: "github" }, "github"],
		["/sign-in/social", { provider: "google" }, "google"],
		["/link-social", { provider: "github" }, "github"],
		["/callback/github", undefined, "github"],
		["/callback/google", undefined, "google"],
		["/passkey/generate-authenticate-options", undefined, "passkey"],
		["/passkey/verify-authentication", undefined, "passkey"],
	] as const)("%s maps to %s", (path, body, method) => {
		expect(loginMethodForPath(path, body)).toBe(method);
	});

	it.each([
		["/sign-in/social", { provider: "discord" }],
		["/sign-in/social", undefined],
		["/callback/discord", undefined],
		// Registering a passkey while signed in is not a sign-in method.
		["/passkey/generate-register-options", undefined],
		["/passkey/verify-registration", undefined],
		["/two-factor/verify-totp", undefined],
		["/get-session", undefined],
	] as const)("%s is not gated", (path, body) => {
		expect(loginMethodForPath(path, body)).toBeNull();
	});
});
