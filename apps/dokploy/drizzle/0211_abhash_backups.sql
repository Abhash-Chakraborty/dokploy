CREATE TABLE IF NOT EXISTS "abhash_backup_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"server_id" text,
	"target_kind" text NOT NULL,
	"target" text NOT NULL,
	"repository_id" text NOT NULL,
	"copy_to_repository_ids" text[] DEFAULT '{}' NOT NULL,
	"cron_expression" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"retention" jsonb DEFAULT '{"last":3,"daily":7,"weekly":4,"monthly":6,"yearly":1}'::jsonb NOT NULL,
	"rpo_hours" integer DEFAULT 26 NOT NULL,
	"stop_service" boolean DEFAULT false NOT NULL,
	"pre_hook" text,
	"post_hook" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_backup_repository" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"repository" text NOT NULL,
	"password_ref" text NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp,
	"last_check_ok" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_backup_run" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"job_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"snapshot_id" text,
	"bytes_added" bigint,
	"bytes_processed" bigint,
	"duration_ms" integer,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_drill_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"where" text DEFAULT 'isolated-local' NOT NULL,
	"drill_server_id" text,
	"cron_expression" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"rto_minutes" integer DEFAULT 30 NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_drill_run" (
	"id" text PRIMARY KEY NOT NULL,
	"drill_policy_id" text NOT NULL,
	"job_id" text,
	"snapshot_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"rto_seconds" integer,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_backup_policy" ADD CONSTRAINT "abhash_backup_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_backup_policy" ADD CONSTRAINT "abhash_backup_policy_server_id_server_serverId_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_backup_policy" ADD CONSTRAINT "abhash_backup_policy_repository_id_abhash_backup_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."abhash_backup_repository"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_backup_repository" ADD CONSTRAINT "abhash_backup_repository_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_backup_run" ADD CONSTRAINT "abhash_backup_run_policy_id_abhash_backup_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."abhash_backup_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_drill_policy" ADD CONSTRAINT "abhash_drill_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_drill_policy" ADD CONSTRAINT "abhash_drill_policy_policy_id_abhash_backup_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."abhash_backup_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_drill_policy" ADD CONSTRAINT "abhash_drill_policy_drill_server_id_server_serverId_fk" FOREIGN KEY ("drill_server_id") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_drill_run" ADD CONSTRAINT "abhash_drill_run_drill_policy_id_abhash_drill_policy_id_fk" FOREIGN KEY ("drill_policy_id") REFERENCES "public"."abhash_drill_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_backup_policy_name_idx" ON "abhash_backup_policy" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_backup_policy_server_idx" ON "abhash_backup_policy" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_backup_repository_name_idx" ON "abhash_backup_repository" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_backup_run_policy_idx" ON "abhash_backup_run" USING btree ("policy_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_drill_run_policy_idx" ON "abhash_drill_run" USING btree ("drill_policy_id","started_at");
