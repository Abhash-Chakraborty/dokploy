-- Fork-only. Keeps abhash_role_binding free of grants on deleted resources,
-- members and teams. Idempotent: functions are replaced, triggers recreated.
CREATE OR REPLACE FUNCTION abhash_drop_scope_bindings() RETURNS trigger AS $$
BEGIN
	DELETE FROM "abhash_role_binding"
	WHERE "scope_type" = TG_ARGV[0]
		AND "scope_id" = (row_to_json(OLD) ->> TG_ARGV[1]);
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION abhash_drop_member_grants() RETURNS trigger AS $$
BEGIN
	DELETE FROM "abhash_role_binding"
	WHERE "organization_id" = OLD."organization_id"
		AND "subject_type" = 'user'
		AND "subject_id" = OLD."user_id";
	DELETE FROM "abhash_team_member" tm
	USING "abhash_team" t
	WHERE tm."team_id" = t."id"
		AND t."organization_id" = OLD."organization_id"
		AND tm."user_id" = OLD."user_id";
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION abhash_drop_team_grants() RETURNS trigger AS $$
BEGIN
	DELETE FROM "abhash_role_binding"
	WHERE "subject_type" = 'team' AND "subject_id" = OLD."id";
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
DECLARE
	target record;
BEGIN
	FOR target IN
		SELECT * FROM (VALUES
			('project', 'project', 'projectId'),
			('environment', 'environment', 'environmentId'),
			('application', 'service', 'applicationId'),
			('compose', 'service', 'composeId'),
			('postgres', 'service', 'postgresId'),
			('mysql', 'service', 'mysqlId'),
			('mariadb', 'service', 'mariadbId'),
			('mongo', 'service', 'mongoId'),
			('redis', 'service', 'redisId'),
			('libsql', 'service', 'libsqlId'),
			('server', 'server', 'serverId'),
			('git_provider', 'gitProvider', 'gitProviderId')
		) AS t(tbl, scope, pk)
	LOOP
		EXECUTE format('DROP TRIGGER IF EXISTS abhash_drop_scope_bindings ON %I', target.tbl);
		EXECUTE format(
			'CREATE TRIGGER abhash_drop_scope_bindings AFTER DELETE ON %I FOR EACH ROW EXECUTE FUNCTION abhash_drop_scope_bindings(%L, %L)',
			target.tbl, target.scope, target.pk
		);
	END LOOP;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS abhash_drop_member_grants ON "member";
--> statement-breakpoint
CREATE TRIGGER abhash_drop_member_grants AFTER DELETE ON "member"
	FOR EACH ROW EXECUTE FUNCTION abhash_drop_member_grants();
--> statement-breakpoint
DROP TRIGGER IF EXISTS abhash_drop_team_grants ON "abhash_team";
--> statement-breakpoint
CREATE TRIGGER abhash_drop_team_grants AFTER DELETE ON "abhash_team"
	FOR EACH ROW EXECUTE FUNCTION abhash_drop_team_grants();
