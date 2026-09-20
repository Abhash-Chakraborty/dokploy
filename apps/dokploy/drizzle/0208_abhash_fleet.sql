CREATE TABLE IF NOT EXISTS "abhash_server_group" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_server_meta" (
	"server_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"group_id" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"environment_label" text,
	"connect_via" text DEFAULT 'public' NOT NULL,
	"host_key" text,
	"host_key_mismatch" boolean DEFAULT false NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"health_message" text,
	"facts" jsonb,
	"maintenance" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_group" ADD CONSTRAINT "abhash_server_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_meta" ADD CONSTRAINT "abhash_server_meta_server_id_server_serverId_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_meta" ADD CONSTRAINT "abhash_server_meta_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_meta" ADD CONSTRAINT "abhash_server_meta_group_id_abhash_server_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."abhash_server_group"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_server_group_name_idx" ON "abhash_server_group" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_server_meta_org_idx" ON "abhash_server_meta" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_server_meta_health_idx" ON "abhash_server_meta" USING btree ("health");
