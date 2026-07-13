import { dbUrl } from "@dokploy/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { runMigration } from "./migration-runner";

const sql = postgres(dbUrl, { max: 1 });
const db = drizzle(sql);

await runMigration({
	close: () => sql.end(),
	error: console.error,
	log: console.log,
	migrate: () => migrate(db, { migrationsFolder: "drizzle" }),
});
