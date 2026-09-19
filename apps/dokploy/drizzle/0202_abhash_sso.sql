CREATE TABLE IF NOT EXISTS "abhash_sso_group_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider_id" text,
	"group_name" text NOT NULL,
	"org_role" text,
	"team_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_sso_provider" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" text DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"show_on_login" boolean DEFAULT true NOT NULL,
	"jit_enabled" boolean DEFAULT true NOT NULL,
	"require_group_match" boolean DEFAULT false NOT NULL,
	"groups_claim" text DEFAULT 'groups' NOT NULL,
	"default_role" text DEFAULT 'member' NOT NULL,
	"max_role" text DEFAULT 'admin' NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_sso_group_mapping" ADD CONSTRAINT "abhash_sso_group_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_sso_group_mapping" ADD CONSTRAINT "abhash_sso_group_mapping_provider_id_sso_provider_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_provider"("provider_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_sso_group_mapping" ADD CONSTRAINT "abhash_sso_group_mapping_team_id_abhash_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."abhash_team"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_sso_provider" ADD CONSTRAINT "abhash_sso_provider_provider_id_sso_provider_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_provider"("provider_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_sso_group_mapping_org_idx" ON "abhash_sso_group_mapping" USING btree ("organization_id");
