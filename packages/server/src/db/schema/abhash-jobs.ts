import {
	type AnyPgColumn,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

export type AbhashJobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export type AbhashJobActor = {
	type: "user" | "agent" | "apiKey" | "schedule" | "system";
	id?: string;
	name?: string;
};

/**
 * Durable history of every background job. Redis (BullMQ) only carries the
 * work in flight; this table is the source of truth the UI, API and agents
 * read, and it survives a Redis flush or restart.
 */
export const abhashJob = pgTable(
	"abhash_job",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		type: text("type").notNull(),
		title: text("title").notNull(),
		status: text("status").$type<AbhashJobStatus>().notNull().default("queued"),
		targetType: text("target_type"),
		targetId: text("target_id"),
		actor: jsonb("actor").$type<AbhashJobActor>().notNull(),
		input: jsonb("input").$type<Record<string, unknown>>().notNull(),
		result: jsonb("result").$type<unknown>(),
		error: text("error"),
		progress: integer("progress"),
		attempts: integer("attempts").notNull().default(0),
		parentId: text("parent_id").references((): AnyPgColumn => abhashJob.id, {
			onDelete: "cascade",
		}),
		scheduleId: text("schedule_id"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		startedAt: timestamp("started_at"),
		finishedAt: timestamp("finished_at"),
	},
	(t) => [
		index("abhash_job_org_created_idx").on(t.organizationId, t.createdAt),
		index("abhash_job_status_idx").on(t.status),
		index("abhash_job_target_idx").on(t.targetType, t.targetId),
		index("abhash_job_parent_idx").on(t.parentId),
	],
);
