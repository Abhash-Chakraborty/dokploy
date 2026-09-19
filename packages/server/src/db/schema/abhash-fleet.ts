import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { server } from "./server";

export type ServerHealth = "unknown" | "online" | "degraded" | "offline";

export type ServerFacts = {
	os?: string;
	kernel?: string;
	cpuCores?: number;
	memoryMb?: number;
	diskUsedPercent?: number;
	load1?: number;
	uptimeSeconds?: number;
	dockerVersion?: string;
	swarm?: string;
	collectedAt?: string;
};

export const abhashServerGroup = pgTable(
	"abhash_server_group",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_server_group_name_idx").on(t.organizationId, t.name),
	],
);

/**
 * Everything the command centre knows about a server beyond upstream's row:
 * how to reach it, its pinned host key, what it is for, and how it looked
 * the last time we asked.
 */
export const abhashServerMeta = pgTable(
	"abhash_server_meta",
	{
		serverId: text("server_id")
			.primaryKey()
			.references(() => server.serverId, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		groupId: text("group_id").references(() => abhashServerGroup.id, {
			onDelete: "set null",
		}),
		tags: text("tags").array().notNull().default([]),
		/** prod, staging, dev — free text, used for filtering and guard rails. */
		environmentLabel: text("environment_label"),
		/** Which address Dokploy connects to: the public one or the mesh. */
		connectVia: text("connect_via")
			.$type<"public" | "mesh">()
			.notNull()
			.default("public"),
		/** Trusted on first use; a change blocks connections until accepted. */
		hostKey: text("host_key"),
		hostKeyMismatch: boolean("host_key_mismatch").notNull().default(false),
		health: text("health").$type<ServerHealth>().notNull().default("unknown"),
		healthMessage: text("health_message"),
		facts: jsonb("facts").$type<ServerFacts>(),
		maintenance: boolean("maintenance").notNull().default(false),
		lastSeenAt: timestamp("last_seen_at"),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("abhash_server_meta_org_idx").on(t.organizationId),
		index("abhash_server_meta_health_idx").on(t.health),
	],
);
