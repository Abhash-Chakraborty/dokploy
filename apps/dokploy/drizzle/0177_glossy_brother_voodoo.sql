-- Fork note: this fork shipped its own passkey table in v0.29.12 (legacy migration
-- 0175_wandering_wonder_man), before upstream added passkey support here. On a fork
-- database the table, its FK and its indexes may already exist, so every statement
-- below is guarded. On a fresh database the effect is identical to upstream's version.
CREATE TABLE IF NOT EXISTS "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");
