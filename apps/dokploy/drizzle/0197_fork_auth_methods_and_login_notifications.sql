-- Fork-only columns. These originally shipped in v0.29.12 as migration
-- 0175_wandering_wonder_man, then as 0186, and were renumbered each time
-- upstream claimed the same index. Guarded so databases that already ran an
-- earlier copy re-apply this as a no-op.
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "userLogin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "authMethodsConfig" jsonb DEFAULT '{"emailPassword":true,"github":true,"google":true,"passkey":true}'::jsonb NOT NULL;
