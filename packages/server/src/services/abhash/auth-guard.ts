import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { IS_CLOUD } from "../../constants";
import { db } from "../../db";
import { account, passkey } from "../../db/schema";
import { getWebServerSettings } from "../web-server-settings";

export type LoginMethod = "emailPassword" | "github" | "google" | "passkey";
export type AuthMethodsConfig = Record<LoginMethod, boolean>;

export const ALL_METHODS_ENABLED: AuthMethodsConfig = {
	emailPassword: true,
	github: true,
	google: true,
	passkey: true,
};

// The SSO and SCIM plugins stay registered so their tables and server-side
// APIs exist, but their management endpoints must never be reachable over
// HTTP: /sso/register only needs a session, and a provider registered for the
// owner's email domain could be used to take over the owner's account. Fork
// routers call these through auth.api.* (no request), which is allowed.
const HTTP_BLOCKED_PREFIXES = [
	"/sso/",
	"/sign-in/sso",
	"/scim/generate-token",
	"/scim/list-provider-connections",
	"/scim/get-provider-connection",
	"/scim/delete-provider-connection",
	"/organization/create-role",
	"/organization/update-role",
	"/organization/delete-role",
	"/organization/update-member-role",
];

const SOCIAL_METHODS = new Set<LoginMethod>(["github", "google"]);

const asSocialMethod = (provider: unknown): LoginMethod | null =>
	typeof provider === "string" && SOCIAL_METHODS.has(provider as LoginMethod)
		? (provider as LoginMethod)
		: null;

/** The login method an auth endpoint belongs to, or null if it is not gated. */
export const loginMethodForPath = (
	path: string,
	body: unknown,
): LoginMethod | null => {
	if (
		path === "/sign-in/email" ||
		path === "/sign-up/email" ||
		path === "/request-password-reset" ||
		path === "/forget-password" ||
		path.startsWith("/reset-password")
	) {
		return "emailPassword";
	}
	if (path === "/sign-in/social" || path === "/link-social") {
		return asSocialMethod((body as { provider?: unknown } | null)?.provider);
	}
	if (path.startsWith("/callback/")) {
		return asSocialMethod(path.slice("/callback/".length));
	}
	if (
		path === "/passkey/generate-authenticate-options" ||
		path === "/passkey/verify-authentication"
	) {
		return "passkey";
	}
	return null;
};

export const isHttpBlockedPath = (path: string) =>
	HTTP_BLOCKED_PREFIXES.some((prefix) => path.startsWith(prefix));

const CACHE_TTL_MS = 10_000;
let cached: { value: AuthMethodsConfig; expiresAt: number } | null = null;

export const invalidateAuthMethodsCache = () => {
	cached = null;
};

export const getEffectiveAuthMethods = async (): Promise<AuthMethodsConfig> => {
	if (IS_CLOUD) return ALL_METHODS_ENABLED;
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const settings = await getWebServerSettings();
	const value = {
		...ALL_METHODS_ENABLED,
		...(settings?.authMethodsConfig ?? {}),
	};
	cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
	return value;
};

export const abhashAuthBefore = createAuthMiddleware(async (ctx) => {
	const path = ctx.path ?? "";
	if (ctx.request && isHttpBlockedPath(path)) {
		throw new APIError("NOT_FOUND");
	}

	const method = loginMethodForPath(path, ctx.body);
	if (!method) return;
	const methods = await getEffectiveAuthMethods();
	if (!methods[method]) {
		throw new APIError("FORBIDDEN", {
			message: "This sign-in method is disabled",
		});
	}
});

const socialConfigured: Record<"github" | "google", () => boolean> = {
	github: () =>
		!!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
	google: () =>
		!!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
};

/**
 * Login methods the given user could actually sign in with under `config`.
 * Used to refuse a change that would lock its author out, now that disabled
 * methods are rejected by the server instead of merely hidden.
 */
export const usableMethodsFor = async (
	userId: string,
	config: AuthMethodsConfig,
): Promise<LoginMethod[]> => {
	const [accounts, passkeys] = await Promise.all([
		db.query.account.findMany({
			where: eq(account.userId, userId),
			columns: { providerId: true },
		}),
		db.query.passkey.findMany({
			where: eq(passkey.userId, userId),
			columns: { id: true },
		}),
	]);
	const providers = new Set(accounts.map((a) => a.providerId));
	const usable: LoginMethod[] = [];
	if (config.emailPassword && providers.has("credential")) {
		usable.push("emailPassword");
	}
	for (const social of ["github", "google"] as const) {
		if (config[social] && socialConfigured[social]() && providers.has(social)) {
			usable.push(social);
		}
	}
	if (config.passkey && passkeys.length > 0) usable.push("passkey");
	return usable;
};
