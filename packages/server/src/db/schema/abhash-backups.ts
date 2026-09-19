import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { server } from "./server";

export type RetentionPolicy = {
	last: number;
	daily: number;
	weekly: number;
	monthly: number;
	yearly: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = {
	last: 3,
	daily: 7,
	weekly: 4,
	monthly: 6,
	yearly: 1,
};

/**
 * A restic repository. The repository string can point at any rclone
 * backend (S3, B2, SFTP, WebDAV, local), and both the password and the
 * backend credentials are ${{secret.NAME}} references.
 */
export const abhashBackupRepository = pgTable(
	"abhash_backup_repository",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** e.g. s3:s3.amazonaws.com/bucket/path, or rclone:remote:path. */
		repository: text("repository").notNull(),
		passwordRef: text("password_ref").notNull(),
		/** Backend credentials as env vars, values may be secret references. */
		env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
		initialized: boolean("initialized").notNull().default(false),
		lastCheckAt: timestamp("last_check_at"),
		lastCheckOk: boolean("last_check_ok"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_backup_repository_name_idx").on(
			t.organizationId,
			t.name,
		),
	],
);

export type BackupTargetKind =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "volume"
	| "path"
	| "dokploy";

export const abhashBackupPolicy = pgTable(
	"abhash_backup_policy",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** Null means the Dokploy host itself. */
		serverId: text("server_id").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		targetKind: text("target_kind").$type<BackupTargetKind>().notNull(),
		/** Service id, volume name or path, depending on the kind. */
		target: text("target").notNull(),
		repositoryId: text("repository_id")
			.notNull()
			.references(() => abhashBackupRepository.id, { onDelete: "restrict" }),
		/** Copies of every snapshot, for the 3-2-1 rule. */
		copyToRepositoryIds: text("copy_to_repository_ids")
			.array()
			.notNull()
			.default([]),
		cronExpression: text("cron_expression"),
		timezone: text("timezone").notNull().default("UTC"),
		retention: jsonb("retention")
			.$type<RetentionPolicy>()
			.notNull()
			.default(DEFAULT_RETENTION),
		/** Hours after which a missing backup counts as a problem. */
		rpoHours: integer("rpo_hours").notNull().default(26),
		stopService: boolean("stop_service").notNull().default(false),
		preHook: text("pre_hook"),
		postHook: text("post_hook"),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_backup_policy_name_idx").on(t.organizationId, t.name),
		index("abhash_backup_policy_server_idx").on(t.serverId),
	],
);

export type BackupStats = {
	/** Recorded with the snapshot, so a drill can check the restore matches. */
	tables?: number;
	rows?: number;
	schemaHash?: string;
	objects?: number;
	note?: string;
};

export const abhashBackupRun = pgTable(
	"abhash_backup_run",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		policyId: text("policy_id")
			.notNull()
			.references(() => abhashBackupPolicy.id, { onDelete: "cascade" }),
		jobId: text("job_id"),
		status: text("status")
			.$type<"running" | "succeeded" | "failed">()
			.notNull()
			.default("running"),
		snapshotId: text("snapshot_id"),
		bytesAdded: bigint("bytes_added", { mode: "number" }),
		bytesProcessed: bigint("bytes_processed", { mode: "number" }),
		durationMs: integer("duration_ms"),
		stats: jsonb("stats").$type<BackupStats>(),
		error: text("error"),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
	},
	(t) => [index("abhash_backup_run_policy_idx").on(t.policyId, t.startedAt)],
);

export type DrillCheck = {
	name: string;
	ok: boolean;
	detail: string;
};

export const abhashDrillPolicy = pgTable("abhash_drill_policy", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	policyId: text("policy_id")
		.notNull()
		.references(() => abhashBackupPolicy.id, { onDelete: "cascade" }),
	/** Where the restore happens: an isolated container, or a drill server. */
	where: text("where")
		.$type<"isolated-local" | "drill-server">()
		.notNull()
		.default("isolated-local"),
	drillServerId: text("drill_server_id").references(() => server.serverId, {
		onDelete: "set null",
	}),
	cronExpression: text("cron_expression"),
	timezone: text("timezone").notNull().default("UTC"),
	/** Fails the drill when the restore takes longer than this. */
	rtoMinutes: integer("rto_minutes").notNull().default(30),
	/** Extra assertions, run against the restored copy. */
	queries: jsonb("queries")
		.$type<{ name: string; sql: string; expect?: string }[]>()
		.notNull()
		.default([]),
	enabled: boolean("enabled").notNull().default(true),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const abhashDrillRun = pgTable(
	"abhash_drill_run",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		drillPolicyId: text("drill_policy_id")
			.notNull()
			.references(() => abhashDrillPolicy.id, { onDelete: "cascade" }),
		jobId: text("job_id"),
		snapshotId: text("snapshot_id"),
		status: text("status")
			.$type<"running" | "passed" | "failed">()
			.notNull()
			.default("running"),
		/** How long a real restore would take: start to verified. */
		rtoSeconds: integer("rto_seconds"),
		checks: jsonb("checks").$type<DrillCheck[]>().notNull().default([]),
		error: text("error"),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
	},
	(t) => [index("abhash_drill_run_policy_idx").on(t.drillPolicyId, t.startedAt)],
);
