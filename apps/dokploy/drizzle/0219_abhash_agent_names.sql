-- Service accounts were created without a name on their user row, so member
-- lists showed only the generated agents.invalid address. Copy the agent's
-- name over; safe to run again.
UPDATE "user" AS u
SET "firstName" = a."name"
FROM "abhash_agent" AS a
WHERE a."user_id" = u."id"
	AND COALESCE(u."firstName", '') = '';
--> statement-breakpoint
-- Agent keys were issued with the API key plugin's default limit of ten
-- requests a day, which an agent spends in minutes. Lift it where it was never
-- changed by hand; agents are governed by their key policy instead.
UPDATE "apikey" AS k
SET "rate_limit_enabled" = false
FROM "abhash_agent" AS a
WHERE k."reference_id" = a."user_id"
	AND k."rate_limit_enabled" = true
	AND k."rate_limit_max" = 10
	AND k."rate_limit_time_window" = 86400000;
