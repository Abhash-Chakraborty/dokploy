CREATE TABLE IF NOT EXISTS "abhash_ansible_project" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abhash_ansible_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"playbook" text NOT NULL,
	"targets" jsonb DEFAULT '{"serverIds":[],"all":false}'::jsonb NOT NULL,
	"extra_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_mode" boolean DEFAULT true NOT NULL,
	"become" boolean DEFAULT true NOT NULL,
	"forks" integer DEFAULT 5 NOT NULL,
	"limit_pattern" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"cron_expression" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_ansible_project" ADD CONSTRAINT "abhash_ansible_project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_ansible_template" ADD CONSTRAINT "abhash_ansible_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "abhash_ansible_template" ADD CONSTRAINT "abhash_ansible_template_project_id_abhash_ansible_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."abhash_ansible_project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_ansible_project_name_idx" ON "abhash_ansible_project" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abhash_ansible_template_name_idx" ON "abhash_ansible_template" USING btree ("organization_id","name");
