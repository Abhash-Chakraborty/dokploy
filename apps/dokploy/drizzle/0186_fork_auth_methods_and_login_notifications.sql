-- Fork-only columns. These originally shipped in v0.29.12 as migration
-- 0175_wandering_wonder_man, which collided with upstream's 0175 and had to be
-- renumbered past upstream's 0185. Guarded so databases that already ran the
-- legacy migration re-apply this as a no-op.
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "userLogin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "authMethodsConfig" jsonb DEFAULT '{"emailPassword":true,"github":true,"google":true,"passkey":true}'::jsonb NOT NULL;
