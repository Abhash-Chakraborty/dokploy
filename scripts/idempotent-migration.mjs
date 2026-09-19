// Rewrites a drizzle-kit generated migration so it can safely run again.
//
// Fork migrations are renumbered whenever upstream claims their index, and a
// database that already applied the old number then re-runs them. Usage:
//   node scripts/idempotent-migration.mjs apps/dokploy/drizzle/0200_x.sql
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: idempotent-migration.mjs <migration.sql>");
	process.exit(1);
}

const guard = (statement) =>
	`DO $$ BEGIN\n\t${statement.trim().replace(/;$/, "")};\nEXCEPTION WHEN duplicate_object THEN null;\nEND $$;`;

const statements = readFileSync(file, "utf8").split("--> statement-breakpoint");
const rewritten = statements.map((raw) => {
	const leading = raw.match(/^\s*/)[0];
	const body = raw.trim();
	let out = body
		.replace(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "')
		.replace(
			/^CREATE (UNIQUE )?INDEX "/,
			(_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS "`,
		)
		.replace(
			/^ALTER TABLE ("[^"]+") ADD COLUMN "/,
			'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS "',
		);
	if (
		/^CREATE TYPE /.test(out) ||
		/^ALTER TABLE "[^"]+" ADD CONSTRAINT /.test(out)
	) {
		out = guard(out);
	}
	return leading + out;
});
writeFileSync(file, `${rewritten.join("--> statement-breakpoint")}\n`);
console.log(`made ${file} idempotent`);
