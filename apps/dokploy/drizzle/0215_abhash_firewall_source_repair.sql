-- A rule's source was written to its text column as the string
-- "[object Object]", so what it said is gone and it read back as "anywhere".
-- Such a rule is switched off and marked, never left open: it has to be
-- entered again. Running this twice changes nothing.
UPDATE "abhash_firewall_rule"
SET "enabled" = false,
	"source" = '{"kind":"any"}',
	"comment" = left("comment" || ' (source was lost: set it again)', 120)
WHERE "source" = '[object Object]';
