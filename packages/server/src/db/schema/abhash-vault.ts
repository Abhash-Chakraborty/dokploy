import {
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

export type AbhashSecretScope = "organization" | "project" | "environment";

/**
 * A secret in the built-in vault. Only metadata lives here; values are in
 * abhash_secret_version, encrypted under a per-version data key wrapped by
 * the instance master key. Referenced from config as ${{secret.NAME}}.
 */
export const abhashSecret = pgTable(
	"abhash_secret",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		scopeType: text("scope_type").$type<AbhashSecretScope>().notNull(),
		// The organization, project or environment id the secret belongs to.
		scopeId: text("scope_id").notNull(),
		tags: text("tags").array().notNull().default([]),
		currentVersion: integer("current_version").notNull().default(0),
		expiresAt: timestamp("expires_at"),
		rotateEveryDays: integer("rotate_every_days"),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		valueUpdatedAt: timestamp("value_updated_at"),
		lastUsedAt: timestamp("last_used_at"),
	},
	(t) => [
		uniqueIndex("abhash_secret_scope_name_idx").on(
			t.organizationId,
			t.scopeType,
			t.scopeId,
			t.name,
		),
	],
);

export const abhashSecretVersion = pgTable(
	"abhash_secret_version",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		secretId: text("secret_id")
			.notNull()
			.references(() => abhashSecret.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		ciphertext: text("ciphertext").notNull(),
		wrappedKey: text("wrapped_key").notNull(),
		keyId: text("key_id").notNull(),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_secret_version_idx").on(t.secretId, t.version),
		index("abhash_secret_version_key_idx").on(t.keyId),
	],
);

/** Where a secret was last resolved, recorded at deploy time. */
export const abhashSecretUsage = pgTable(
	"abhash_secret_usage",
	{
		secretId: text("secret_id")
			.notNull()
			.references(() => abhashSecret.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		environmentId: text("environment_id").notNull(),
		lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.secretId, t.environmentId] })],
);
