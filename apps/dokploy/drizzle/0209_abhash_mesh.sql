CREATE TABLE IF NOT EXISTS "abhash_mesh_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"token_ref" text NOT NULL,
	"settings" jsonb DEFAULT '{"groupPrefix":"dokploy","manageDns":false,"sshPort":22,"swarmOverMesh":false}'::jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_server_mesh" (
	"server_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"peer_id" text,
	"mesh_ip" text,
	"mesh_hostname" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"client_version" text,
	"adopted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp,
	"last_seen_at" timestamp
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_mesh_provider" ADD CONSTRAINT "abhash_mesh_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_mesh" ADD CONSTRAINT "abhash_server_mesh_server_id_server_serverId_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_mesh" ADD CONSTRAINT "abhash_server_mesh_provider_id_abhash_mesh_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."abhash_mesh_provider"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_mesh_provider_name_idx" ON "abhash_mesh_provider" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_mesh_provider_active_idx" ON "abhash_mesh_provider" USING btree ("organization_id") WHERE "abhash_mesh_provider"."active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_server_mesh_provider_idx" ON "abhash_server_mesh" USING btree ("provider_id");
