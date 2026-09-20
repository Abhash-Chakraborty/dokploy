-- Fork-only. Originally shipped as 0187_log_drains and renumbered past
-- upstream's 0196. Guarded so databases that already ran 0187 re-apply this as
-- a no-op.
DO $$ BEGIN
	CREATE TYPE "public"."LogDrainType" AS ENUM('loki', 'datadog', 'http');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "log_drain" (
	"logDrainId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"drainType" "LogDrainType" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"serverId" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"statusMessage" text,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "log_drain" ADD CONSTRAINT "log_drain_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "log_drain" ADD CONSTRAINT "log_drain_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
