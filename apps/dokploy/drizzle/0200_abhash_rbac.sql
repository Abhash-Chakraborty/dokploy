CREATE TABLE IF NOT EXISTS "abhash_member_meta" (
	"member_id" text PRIMARY KEY NOT NULL,
	"role_source" text DEFAULT 'manual' NOT NULL,
	"role_pinned" boolean DEFAULT false NOT NULL,
	"last_sso_sync_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_role_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"role" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"inherit" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_team" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_team_member" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "abhash_team_member_team_id_user_id_source_pk" PRIMARY KEY("team_id","user_id","source")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_user_suspension" (
	"user_id" text PRIMARY KEY NOT NULL,
	"suspended_at" timestamp DEFAULT now() NOT NULL,
	"suspended_by" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"reason" text,
	"disabled_api_key_ids" text[] DEFAULT '{}' NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_member_meta" ADD CONSTRAINT "abhash_member_meta_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_role_binding" ADD CONSTRAINT "abhash_role_binding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_team" ADD CONSTRAINT "abhash_team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_team_member" ADD CONSTRAINT "abhash_team_member_team_id_abhash_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."abhash_team"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_team_member" ADD CONSTRAINT "abhash_team_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_user_suspension" ADD CONSTRAINT "abhash_user_suspension_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_role_binding_unique_idx" ON "abhash_role_binding" USING btree ("organization_id","subject_type","subject_id","role","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_role_binding_subject_idx" ON "abhash_role_binding" USING btree ("organization_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_role_binding_scope_idx" ON "abhash_role_binding" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_team_org_slug_idx" ON "abhash_team" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_team_external_idx" ON "abhash_team" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_team_member_user_idx" ON "abhash_team_member" USING btree ("user_id");
