import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { server } from "./server";

export type FirewallMode = "off" | "audit" | "enforce";
export type RuleAction = "allow" | "deny" | "limit" | "reject";
export type RuleChain = "input" | "docker";
export type RuleProtocol = "tcp" | "udp";

/**
 * Where traffic may come from. `mesh` and `control` resolve at compile time
 * to the mesh subnet and the address Dokploy connects from, so a rule keeps
 * meaning when those change.
 */
export type RuleSource =
	| { kind: "any" }
	| { kind: "cidr"; value: string }
	| { kind: "mesh" }
	| { kind: "control" }
	| { kind: "group"; groupId: string };

export const abhashFirewallPolicy = pgTable(
	"abhash_firewall_policy",
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
		uniqueIndex("abhash_firewall_policy_name_idx").on(t.organizationId, t.name),
	],
);

export const abhashFirewallRule = pgTable(
	"abhash_firewall_rule",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		policyId: text("policy_id").references(() => abhashFirewallPolicy.id, {
			onDelete: "cascade",
		}),
		serverId: text("server_id").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		chain: text("chain").$type<RuleChain>().notNull().default("input"),
		action: text("action").$type<RuleAction>().notNull().default("allow"),
		protocol: text("protocol").$type<RuleProtocol>().notNull().default("tcp"),
		/** A single port or an inclusive range, e.g. 8000:8010. */
		port: text("port").notNull(),
		source: text("source").$type<RuleSource>().notNull(),
		comment: text("comment").notNull().default(""),
		priority: integer("priority").notNull().default(100),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		index("abhash_firewall_rule_policy_idx").on(t.policyId),
		index("abhash_firewall_rule_server_idx").on(t.serverId),
	],
);

export const abhashServerFirewall = pgTable("abhash_server_firewall", {
	serverId: text("server_id")
		.primaryKey()
		.references(() => server.serverId, { onDelete: "cascade" }),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	mode: text("mode").$type<FirewallMode>().notNull().default("off"),
	policyIds: text("policy_ids").array().notNull().default([]),
	/** Auto rules Dokploy derived but the admin switched off, by reason. */
	disabledAutoRules: text("disabled_auto_rules").array().notNull().default([]),
	appliedHash: text("applied_hash"),
	appliedAt: timestamp("applied_at"),
	driftedAt: timestamp("drifted_at"),
	lastError: text("last_error"),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
