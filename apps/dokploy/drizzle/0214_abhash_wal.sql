ALTER TABLE "abhash_backup_policy" ADD COLUMN IF NOT EXISTS "wal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "abhash_backup_policy" ADD COLUMN IF NOT EXISTS "wal_ship_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "abhash_backup_policy" ADD COLUMN IF NOT EXISTS "wal_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "abhash_backup_policy" ADD COLUMN IF NOT EXISTS "wal_status" jsonb;--> statement-breakpoint
ALTER TABLE "abhash_backup_run" ADD COLUMN IF NOT EXISTS "method" text DEFAULT 'logical' NOT NULL;--> statement-breakpoint
ALTER TABLE "abhash_backup_run" ADD COLUMN IF NOT EXISTS "wal_start" text;