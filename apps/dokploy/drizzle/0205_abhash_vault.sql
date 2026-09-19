CREATE TABLE IF NOT EXISTS "abhash_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"rotate_every_days" integer,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value_updated_at" timestamp,
	"last_used_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_secret_usage" (
	"secret_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "abhash_secret_usage_secret_id_environment_id_pk" PRIMARY KEY("secret_id","environment_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_secret_version" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_id" text NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"key_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_secret" ADD CONSTRAINT "abhash_secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_secret_usage" ADD CONSTRAINT "abhash_secret_usage_secret_id_abhash_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."abhash_secret"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_secret_version" ADD CONSTRAINT "abhash_secret_version_secret_id_abhash_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."abhash_secret"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_secret_scope_name_idx" ON "abhash_secret" USING btree ("organization_id","scope_type","scope_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_secret_version_idx" ON "abhash_secret_version" USING btree ("secret_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_secret_version_key_idx" ON "abhash_secret_version" USING btree ("key_id");
