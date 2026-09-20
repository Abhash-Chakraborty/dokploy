CREATE TABLE IF NOT EXISTS "abhash_forward_auth" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"address" text NOT NULL,
	"trust_forward_header" boolean DEFAULT true NOT NULL,
	"auth_response_headers" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_forward_auth" ADD CONSTRAINT "abhash_forward_auth_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_forward_auth_slug_idx" ON "abhash_forward_auth" USING btree ("slug");
