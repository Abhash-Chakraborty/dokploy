-- Channels that already alert on failed builds get crash-loop alerts too. The
-- backfill runs only when the column is first added, so re-applying this
-- migration never switches a channel back on after someone turned it off.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'notification' AND column_name = 'containerHealth'
	) THEN
		ALTER TABLE "notification" ADD COLUMN "containerHealth" boolean DEFAULT false NOT NULL;
		UPDATE "notification" SET "containerHealth" = true WHERE "appBuildError" = true;
	END IF;
END $$;
