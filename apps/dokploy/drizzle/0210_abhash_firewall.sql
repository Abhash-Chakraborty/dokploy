CREATE TABLE IF NOT EXISTS "abhash_firewall_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_firewall_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"policy_id" text,
	"server_id" text,
	"chain" text DEFAULT 'input' NOT NULL,
	"action" text DEFAULT 'allow' NOT NULL,
	"protocol" text DEFAULT 'tcp' NOT NULL,
	"port" text NOT NULL,
	"source" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_server_firewall" (
	"server_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"policy_ids" text[] DEFAULT '{}' NOT NULL,
	"disabled_auto_rules" text[] DEFAULT '{}' NOT NULL,
	"applied_hash" text,
	"applied_at" timestamp,
	"drifted_at" timestamp,
	"last_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_firewall_policy" ADD CONSTRAINT "abhash_firewall_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_firewall_rule" ADD CONSTRAINT "abhash_firewall_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_firewall_rule" ADD CONSTRAINT "abhash_firewall_rule_policy_id_abhash_firewall_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."abhash_firewall_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_firewall_rule" ADD CONSTRAINT "abhash_firewall_rule_server_id_server_serverId_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_firewall" ADD CONSTRAINT "abhash_server_firewall_server_id_server_serverId_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_server_firewall" ADD CONSTRAINT "abhash_server_firewall_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_firewall_policy_name_idx" ON "abhash_firewall_policy" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_firewall_rule_policy_idx" ON "abhash_firewall_rule" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abhash_firewall_rule_server_idx" ON "abhash_firewall_rule" USING btree ("server_id");
