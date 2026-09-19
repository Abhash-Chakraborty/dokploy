import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { setCredentialEncryption } from "../../../db/schema/abhash-credential";
import {
	decryptValue,
	encryptValue,
	isEncrypted,
} from "../../../lib/encryption";
import { getSetting, setSetting } from "../flags";
import { defineJob } from "../jobs/registry";

/**
 * The credential columns upstream stores in plain text, with the primary key
 * used to rewrite a row. None of them is ever used in a WHERE clause, which
 * is what makes encrypting them safe.
 */
export const CREDENTIAL_COLUMNS: {
	table: string;
	pk: string;
	columns: string[];
	json?: boolean;
}[] = [
	{ table: "ssh-key", pk: "sshKeyId", columns: ["privateKey"] },
	{
		table: "destination",
		pk: "destinationId",
		columns: ["accessKey", "secretAccessKey"],
	},
	{ table: "registry", pk: "registryId", columns: ["password"] },
	{
		table: "github",
		pk: "githubId",
		columns: ["githubClientSecret", "githubPrivateKey", "githubWebhookSecret"],
	},
	{
		table: "gitlab",
		pk: "gitlabId",
		columns: ["secret", "access_token", "refresh_token"],
	},
	{
		table: "gitea",
		pk: "giteaId",
		columns: ["client_secret", "access_token", "refresh_token"],
	},
	{
		table: "bitbucket",
		pk: "bitbucketId",
		columns: ["appPassword", "apiToken"],
	},
	{ table: "ai", pk: "aiId", columns: ["apiKey"] },
	{ table: "cloudflare_tunnel", pk: "cloudflareTunnelId", columns: ["token"] },
	{ table: "certificate", pk: "certificateId", columns: ["privateKey"] },
	{
		table: "webServerSettings",
		pk: "id",
		columns: ["sshPrivateKey"],
	},
	{ table: "security", pk: "securityId", columns: ["password"] },
	{ table: "postgres", pk: "postgresId", columns: ["databasePassword"] },
	{
		table: "mysql",
		pk: "mysqlId",
		columns: ["databasePassword", "rootPassword"],
	},
	{
		table: "mariadb",
		pk: "mariadbId",
		columns: ["databasePassword", "rootPassword"],
	},
	{ table: "mongo", pk: "mongoId", columns: ["databasePassword"] },
	{ table: "redis", pk: "redisId", columns: ["password"] },
	{ table: "libsql", pk: "libsqlId", columns: ["databasePassword"] },
	{ table: "slack", pk: "slackId", columns: ["webhookUrl"] },
	{ table: "telegram", pk: "telegramId", columns: ["botToken"] },
	{ table: "discord", pk: "discordId", columns: ["webhookUrl"] },
	{ table: "email", pk: "emailId", columns: ["password"] },
	{ table: "resend", pk: "resendId", columns: ["apiKey"] },
	{ table: "gotify", pk: "gotifyId", columns: ["appToken"] },
	{ table: "ntfy", pk: "ntfyId", columns: ["accessToken"] },
	{ table: "mattermost", pk: "mattermostId", columns: ["webhookUrl"] },
	{ table: "pushover", pk: "pushoverId", columns: ["userKey", "apiToken"] },
	{ table: "lark", pk: "larkId", columns: ["webhookUrl"] },
	{ table: "teams", pk: "teamsId", columns: ["webhookUrl"] },
	{
		table: "vault_provider",
		pk: "vaultProviderId",
		columns: ["config"],
		json: true,
	},
];

const ident = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);

const convertColumn = async (
	table: string,
	pk: string,
	column: string,
	json: boolean,
	mode: "encrypt" | "decrypt",
) => {
	const rows = await db.execute<Record<string, unknown>>(sql`
		SELECT ${ident(pk)} AS pk, ${ident(column)} AS value
		FROM ${ident(table)}
		WHERE ${ident(column)} IS NOT NULL`);
	let changed = 0;
	for (const row of rows) {
		// A jsonb credential is stored as a JSON string once encrypted.
		const raw = row.value;
		const stored = json
			? typeof raw === "string"
				? raw
				: JSON.stringify(raw)
			: String(raw);
		if (!stored) continue;
		const encrypted = isEncrypted(stored);
		if (mode === "encrypt" && encrypted) continue;
		if (mode === "decrypt" && !encrypted) continue;
		const next =
			mode === "encrypt" ? encryptValue(stored) : decryptValue(stored);
		await db.execute(sql`
			UPDATE ${ident(table)}
			SET ${ident(column)} = ${json ? sql`to_jsonb(${next}::text)` : sql`${next}`}
			WHERE ${ident(pk)} = ${row.pk as string}`);
		changed++;
	}
	return changed;
};

/**
 * Rewrites every credential column in place. Safe to re-run: rows already in
 * the target form are skipped, so an interrupted run just continues.
 */
export const convertCredentials = async (
	mode: "encrypt" | "decrypt",
	onProgress?: (line: string) => Promise<void>,
) => {
	let total = 0;
	for (const entry of CREDENTIAL_COLUMNS) {
		for (const column of entry.columns) {
			const changed = await convertColumn(
				entry.table,
				entry.pk,
				column,
				entry.json ?? false,
				mode,
			);
			total += changed;
			if (changed) await onProgress?.(`${entry.table}.${column}: ${changed}`);
		}
	}
	return total;
};

export const credentialEncryptionEnabled = () =>
	getSetting("vault.encryptCredentials", false);

export const loadCredentialEncryption = async () => {
	setCredentialEncryption(await credentialEncryptionEnabled());
};

/**
 * Turning this on encrypts new writes immediately and converts what is
 * already stored. Turning it off converts back, so the previous image keeps
 * working after a rollback.
 */
export const setCredentialEncryptionEnabled = async (
	enabled: boolean,
	userId: string,
	onProgress?: (line: string) => Promise<void>,
) => {
	await setSetting("vault.encryptCredentials", enabled, userId);
	setCredentialEncryption(enabled);
	return convertCredentials(enabled ? "encrypt" : "decrypt", onProgress);
};

export const credentialsJob = defineJob({
	type: "vault.convert-credentials",
	queue: "abhash-infra",
	input: z.object({
		enabled: z.boolean(),
		userId: z.string(),
	}),
	title: (input) =>
		input.enabled ? "Encrypt stored credentials" : "Decrypt stored credentials",
	lock: () => ({ key: "vault:credentials", limit: 1 }),
	run: async ({ input, log }) => {
		const changed = await setCredentialEncryptionEnabled(
			input.enabled,
			input.userId,
			log,
		);
		await log(`Converted ${changed} value(s)`);
		return { changed };
	},
});
