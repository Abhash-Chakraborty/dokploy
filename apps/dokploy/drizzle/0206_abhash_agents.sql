CREATE TABLE IF NOT EXISTS "abhash_agent" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_api_key_policy" (
	"key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"allow" text[] DEFAULT '{}' NOT NULL,
	"ip_allow_list" text[] DEFAULT '{}' NOT NULL,
	"approval_mode" text DEFAULT 'destructive' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"requester" jsonb NOT NULL,
	"operation" text NOT NULL,
	"summary" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp,
	"reason" text,
	"job_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_agent" ADD CONSTRAINT "abhash_agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_agent" ADD CONSTRAINT "abhash_agent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_api_key_policy" ADD CONSTRAINT "abhash_api_key_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_api_key_policy" ADD CONSTRAINT "abhash_api_key_policy_agent_id_abhash_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."abhash_agent"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_approval" ADD CONSTRAINT "abhash_approval_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_agent_name_idx" ON "abhash_agent" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_agent_user_idx" ON "abhash_agent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_approval_org_status_idx" ON "abhash_approval" USING btree ("organization_id","status");
