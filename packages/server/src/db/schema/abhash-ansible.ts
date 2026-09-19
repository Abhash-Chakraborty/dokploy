import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

/** Playbooks and the files they need, stored as a small in-database tree. */
export const abhashAnsibleProject = pgTable(
	"abhash_ansible_project",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		/** Relative path -> file contents. */
		files: jsonb("files").$type<Record<string, string>>().notNull().default({}),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_ansible_project_name_idx").on(t.organizationId, t.name),
	],
);

export type AnsibleTargets = {
	/** Server ids, or every server when `all` is set. */
	serverIds: string[];
	all: boolean;
};

/** A playbook plus the servers, variables and options to run it with. */
export const abhashAnsibleTemplate = pgTable(
	"abhash_ansible_template",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => abhashAnsibleProject.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		playbook: text("playbook").notNull(),
		targets: jsonb("targets")
			.$type<AnsibleTargets>()
			.notNull()
			.default({ serverIds: [], all: false }),
		/** May hold ${{secret.NAME}}, resolved into the run's vars file. */
		extraVars: jsonb("extra_vars")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		/** Check mode is the default: a run shows what it would change first. */
		checkMode: boolean("check_mode").notNull().default(true),
		become: boolean("become").notNull().default(true),
		forks: integer("forks").notNull().default(5),
		limitPattern: text("limit_pattern"),
		tags: text("tags").array().notNull().default([]),
		cronExpression: text("cron_expression"),
		timezone: text("timezone").notNull().default("UTC"),
		enabled: boolean("enabled").notNull().default(true),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_ansible_template_name_idx").on(
			t.organizationId,
			t.name,
		),
	],
);
