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
import type { AbhashJobActor } from "./abhash-jobs";
import { organization } from "./account";
import { user } from "./user";

/**
 * A service account for an AI agent or a script. It is a real user row with
 * no login method, so existing role bindings, audit and permissions apply
 * to it unchanged.
 */
export const abhashAgent = pgTable(
	"abhash_agent",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		enabled: boolean("enabled").notNull().default(true),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_agent_name_idx").on(t.organizationId, t.name),
		index("abhash_agent_user_idx").on(t.userId),
	],
);

export type AbhashApprovalMode = "destructive" | "all" | "none";

/** Extra limits on one API key, on top of its owner's permissions. */
export const abhashApiKeyPolicy = pgTable("abhash_api_key_policy", {
	keyId: text("key_id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	agentId: text("agent_id").references(() => abhashAgent.id, {
		onDelete: "cascade",
	}),
	readOnly: boolean("read_only").notNull().default(false),
	/** Procedure patterns the key may call, e.g. `project.*`. Empty = all. */
	allow: text("allow").array().notNull().default([]),
	ipAllowList: text("ip_allow_list").array().notNull().default([]),
	approvalMode: text("approval_mode")
		.$type<AbhashApprovalMode>()
		.notNull()
		.default("destructive"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AbhashApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired"
	| "executed"
	| "failed";

/** A destructive action an agent asked for, waiting for a person. */
export const abhashApproval = pgTable(
	"abhash_approval",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		requester: jsonb("requester").$type<AbhashJobActor>().notNull(),
		operation: text("operation").notNull(),
		summary: text("summary").notNull(),
		input: jsonb("input").$type<Record<string, unknown>>().notNull(),
		status: text("status")
			.$type<AbhashApprovalStatus>()
			.notNull()
			.default("pending"),
		decidedBy: text("decided_by"),
		decidedAt: timestamp("decided_at"),
		reason: text("reason"),
		jobId: text("job_id"),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("abhash_approval_org_status_idx").on(t.organizationId, t.status),
	],
);
