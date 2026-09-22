CREATE TABLE IF NOT EXISTS "abhash_traefik_middleware" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"scope" text DEFAULT 'manual' NOT NULL,
	"project_ids" text[] DEFAULT '{}' NOT NULL,
	"apply_to_dashboard" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_traefik_middleware" ADD CONSTRAINT "abhash_traefik_middleware_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_traefik_middleware_org_name" ON "abhash_traefik_middleware" USING btree ("organization_id","name");