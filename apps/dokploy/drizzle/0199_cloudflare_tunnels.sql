-- Fork-only. Originally shipped as 0188_cloudflare_tunnels and renumbered past
-- upstream's 0196. Guarded so databases that already ran 0188 re-apply this as
-- a no-op.
CREATE TABLE IF NOT EXISTS "cloudflare_tunnel" (
	"cloudflareTunnelId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"serverId" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"statusMessage" text,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cloudflare_tunnel" ADD CONSTRAINT "cloudflare_tunnel_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
