import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { IS_CLOUD } from "../../constants";
import { db } from "../../db";
import { account, member, passkey, user } from "../../db/schema";
import { getWebServerSettings } from "../web-server-settings";
import { createAuditLog } from "./audit-log";
import { getSetting, isFlagEnabled } from "./flags";

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

// OIDC sign-in and its callback: reachable only while SSO is switched on.
// SAML is not offered, so its endpoints stay blocked with the rest of /sso/.
export const isSsoSignInPath = (path: string) =>
	path === "/sign-in/sso" || path.startsWith("/sso/callback/");

export const isHttpBlockedPath = (path: string) =>
	!isSsoSignInPath(path) &&
	HTTP_BLOCKED_PREFIXES.some((prefix) => path.startsWith(prefix));

export type EnforceSso = { enabled: boolean; allowPasskey: boolean };
export const ENFORCE_SSO_OFF: EnforceSso = {
	enabled: false,
	allowPasskey: true,
};

const isOrgOwnerEmail = async (email: unknown) => {
	if (typeof email !== "string" || !email) return false;
	const row = await db
		.select({ role: member.role })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(
			and(eq(user.email, email.toLowerCase().trim()), eq(member.role, "owner")),
		)
		.limit(1);
	return row.length > 0;
};

/**
 * With SSO enforced, only an organization owner may still use a password
 * (sign-in and reset), as a break-glass path should the identity provider be
 * unavailable. Social sign-in is off; passkeys follow the setting.
 */
const assertAllowedUnderEnforcement = async (
	method: LoginMethod,
	path: string,
	body: unknown,
) => {
	const enforce = await getSetting<EnforceSso>("sso.enforce", ENFORCE_SSO_OFF);
	if (!enforce.enabled) return;
	if (method === "passkey" && enforce.allowPasskey) return;
	const email = (body as { email?: unknown } | null)?.email;
	const breakGlass =
		method === "emailPassword" &&
		(path === "/sign-in/email" ||
			path === "/request-password-reset" ||
			path === "/forget-password") &&
		(await isOrgOwnerEmail(email));
	if (breakGlass) {
		await createAuditLog({
			userEmail: String(email),
			userRole: "owner",
			action: "login",
			resourceType: "security",
			resourceName: "break-glass",
			metadata: { path, note: "Password used while SSO is enforced" },
		});
		return;
	}
	throw new APIError("FORBIDDEN", {
		message:
			"Single sign-on is required. Use your organization's SSO provider.",
	});
};

const CACHE_TTL_MS = 10_000;
// Shared across route bundles; see the note in ./flags.ts.
const shared = globalThis as unknown as {
	__abhashAuthMethods?: { value: AuthMethodsConfig; expiresAt: number } | null;
};

export const invalidateAuthMethodsCache = () => {
	shared.__abhashAuthMethods = null;
};

export const getEffectiveAuthMethods = async (): Promise<AuthMethodsConfig> => {
	if (IS_CLOUD) return ALL_METHODS_ENABLED;
	const cached = shared.__abhashAuthMethods;
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const settings = await getWebServerSettings();
	const value = {
		...ALL_METHODS_ENABLED,
		...(settings?.authMethodsConfig ?? {}),
	};
	shared.__abhashAuthMethods = { value, expiresAt: Date.now() + CACHE_TTL_MS };
	return value;
};

export const abhashAuthBefore = createAuthMiddleware(async (ctx) => {
	const path = ctx.path ?? "";
	if (ctx.request && isHttpBlockedPath(path)) {
		throw new APIError("NOT_FOUND");
	}
	if (
		ctx.request &&
		isSsoSignInPath(path) &&
		!(await isFlagEnabled("sso.enabled"))
	) {
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
	await assertAllowedUnderEnforcement(method, path, ctx.body);
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
