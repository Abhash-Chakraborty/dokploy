CREATE TABLE IF NOT EXISTS "abhash_job" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_type" text,
	"target_id" text,
	"actor" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"progress" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"parent_id" text,
	"schedule_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_job" ADD CONSTRAINT "abhash_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_job" ADD CONSTRAINT "abhash_job_parent_id_abhash_job_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."abhash_job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_job_org_created_idx" ON "abhash_job" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_job_status_idx" ON "abhash_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_job_target_idx" ON "abhash_job" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_job_parent_idx" ON "abhash_job" USING btree ("parent_id");
