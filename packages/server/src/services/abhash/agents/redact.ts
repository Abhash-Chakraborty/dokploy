import type { Actor } from "./actor";

export const MASK = "••••";

/** Keys whose value is a credential and never belongs in an agent's reply. */
const SECRET_KEYS = new Set([
	"accessKey",
	"accessToken",
	"apiKey",
	"apiToken",
	"appPassword",
	"appToken",
	"botToken",
	"clientSecret",
	"databasePassword",
	"databaseRootPassword",
	"decryptionPvk",
	"githubClientSecret",
	"githubPrivateKey",
	"githubWebhookSecret",
	"password",
	"privateKey",
	"refreshToken",
	"secret",
	"secretAccessKey",
	"sshPrivateKey",
	"token",
	"userKey",
	"webhookUrl",
]);

/**
 * Fields meant to hold a `${{secret.NAME}}` reference, which is safe to show.
 * They also accept a literal, and a literal is the secret itself.
 */
const REFERENCE_KEYS = new Set(["passwordRef", "secretRef", "tokenRef"]);
const PURE_REFERENCE = /^\$\{\{secret\.[A-Za-z0-9_]+\}\}$/;

export const maskUnlessReference = (value: string) =>
	!value || PURE_REFERENCE.test(value.trim()) ? value : MASK;

/** Keys holding `KEY=value` text, where the names stay but values go. */
const ENV_KEYS = new Set([
	"env",
	"previewEnv",
	"buildArgs",
	"buildSecrets",
	"previewBuildArgs",
	"previewBuildSecrets",
]);

const MAX_DEPTH = 8;

/**
 * Keeps variable names and `${{secret.X}}` references, masks real values, so
 * an agent can still see and edit which variables exist.
 */
export const maskEnvText = (text: string) =>
	text
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (!trimmed || trimmed.startsWith("#")) return line;
			const eq = line.indexOf("=");
			if (eq === -1) return line;
			const name = line.slice(0, eq + 1);
			const value = line.slice(eq + 1).trim();
			return value.startsWith("${{") ? line : `${name}${MASK}`;
		})
		.join("\n");

const redactValue = (value: unknown, key: string, depth: number): unknown => {
	if (value === null || value === undefined) return value;
	if (ENV_KEYS.has(key) && typeof value === "string") return maskEnvText(value);
	if (REFERENCE_KEYS.has(key) && typeof value === "string") {
		return maskUnlessReference(value);
	}
	if (SECRET_KEYS.has(key)) {
		if (typeof value === "string") return value ? MASK : value;
		if (value && typeof value === "object") return MASK;
	}
	if (depth >= MAX_DEPTH) return value;
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, key, depth + 1));
	}
	if (value instanceof Date) return value;
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactValue(v, k, depth + 1);
		}
		return out;
	}
	return value;
};

/**
 * Applied to every response that leaves for an API key or agent. People keep
 * seeing values; the agent surface never has them, which is what makes an
 * agent key safe to hand out.
 */
export const redactForActor = <T>(data: T, actor?: Actor | null): T => {
	if (!actor || actor.type === "user" || actor.type === "system") return data;
	return redactValue(data, "", 0) as T;
};
