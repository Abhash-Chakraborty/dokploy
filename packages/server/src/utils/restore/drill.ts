import { quote } from "shell-quote";

export type DrillDatabaseType = "postgres" | "mysql" | "mariadb";

export interface RestoreDrillResult {
	passed: boolean;
	/** One line the reader can act on. */
	detail: string;
	/** Tables found in the restored copy; 0 means the dump restored empty. */
	tableCount: number;
	scratchDatabase: string;
	durationMs?: number;
}

/**
 * A backup nobody has restored is a hypothesis, not a backup.
 *
 * The drill restores the real dump into a throwaway database beside the live
 * one, counts what landed, and drops it again. It deliberately never touches
 * the production database — the point is to prove the dump is good without
 * betting the live data on finding out.
 */
export const scratchDatabaseName = (suffix: string) =>
	// Lower-case and underscore-only keeps this valid unquoted in all three
	// engines, and the prefix makes an abandoned scratch DB obvious.
	`dokploy_drill_${suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16)}`;

const psql = (user: string, sql: string) =>
	`docker exec -e DB_USER=${quote([user])} -e SQL=${quote([sql])} -i $CONTAINER_ID sh -c 'psql -U "$DB_USER" -d postgres -tAc "$SQL"'`;

const mysqlish = (
	binary: "mysql" | "mariadb",
	user: string,
	password: string,
	sql: string,
) =>
	`docker exec -e DB_USER=${quote([user])} -e DB_PASS=${quote([password])} -e SQL=${quote([sql])} -i $CONTAINER_ID sh -c '${binary} -u "$DB_USER" -p"$DB_PASS" -N -B -e "$SQL"'`;

interface DrillCommands {
	create: string;
	restore: string;
	verify: string;
	drop: string;
}

export const buildDrillCommands = (
	type: DrillDatabaseType,
	scratch: string,
	credentials: { databaseUser: string; databasePassword: string },
): DrillCommands => {
	const { databaseUser, databasePassword } = credentials;

	if (type === "postgres") {
		return {
			create: psql(databaseUser, `CREATE DATABASE ${scratch}`),
			restore: `docker exec -e DB_NAME=${quote([scratch])} -e DB_USER=${quote([databaseUser])} -i $CONTAINER_ID sh -c 'pg_restore -U "$DB_USER" -d "$DB_NAME" -O --clean --if-exists --no-owner'`,
			verify: psql(
				databaseUser,
				`SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
			).replace("-d postgres", `-d ${scratch}`),
			drop: psql(databaseUser, `DROP DATABASE IF EXISTS ${scratch}`),
		};
	}

	const binary = type === "mariadb" ? "mariadb" : "mysql";
	const user = type === "mysql" ? "root" : databaseUser;
	return {
		create: mysqlish(binary, user, databasePassword, `CREATE DATABASE ${scratch}`),
		restore: `docker exec -e DB_NAME=${quote([scratch])} -e DB_USER=${quote([user])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID sh -c '${binary} -u "$DB_USER" -p"$DB_PASS" "$DB_NAME"'`,
		verify: mysqlish(
			binary,
			user,
			databasePassword,
			`SELECT count(*) FROM information_schema.tables WHERE table_schema = '${scratch}'`,
		),
		drop: mysqlish(
			binary,
			user,
			databasePassword,
			`DROP DATABASE IF EXISTS ${scratch}`,
		),
	};
};

/**
 * Assembles the whole drill as one script.
 *
 * The drop runs in a trap so an abandoned scratch database can't survive a
 * failure part way through — leaving one behind on every failed drill would
 * quietly fill the disk of the server you were trying to reassure yourself
 * about.
 */
export const buildRestoreDrillScript = ({
	containerSearchCommand,
	rcloneCommand,
	commands,
}: {
	containerSearchCommand: string;
	rcloneCommand: string;
	commands: DrillCommands;
}) =>
	[
		containerSearchCommand,
		'if [ -z "$CONTAINER_ID" ]; then echo "DRILL_ERROR: database container not found"; exit 1; fi',
		// The drop is a shell function rather than the body of `trap '...'`:
		// the command itself contains single quotes, and POSIX sh concatenates
		// rather than nesting them, so inlining it silently mangles the trap —
		// leaving the scratch database behind on exactly the failed runs the
		// trap exists to clean up after.
		"drill_cleanup() {",
		`\t${commands.drop} >/dev/null 2>&1 || true`,
		"}",
		"trap drill_cleanup EXIT",
		"drill_cleanup",
		`${commands.create} >/dev/null`,
		`${rcloneCommand} | ${commands.restore} >/dev/null`,
		`echo "DRILL_TABLES:$(${commands.verify} | tr -d '[:space:]')"`,
	].join("\n");

export const parseRestoreDrill = (
	scratch: string,
	stdout: string,
	durationMs?: number,
): RestoreDrillResult => {
	const errorLine = stdout
		.split("\n")
		.find((line) => line.includes("DRILL_ERROR:"));
	if (errorLine) {
		return {
			passed: false,
			detail: errorLine.split("DRILL_ERROR:")[1]?.trim() || "The drill failed.",
			tableCount: 0,
			scratchDatabase: scratch,
			durationMs,
		};
	}

	const match = /DRILL_TABLES:(\d+)/.exec(stdout);
	if (!match) {
		return {
			passed: false,
			detail:
				"The restore ran but the verification query returned nothing — treat this backup as unproven.",
			tableCount: 0,
			scratchDatabase: scratch,
			durationMs,
		};
	}

	const tableCount = Number(match[1]);
	if (tableCount === 0) {
		return {
			passed: false,
			detail:
				"The dump restored without error but produced no tables. That's an empty backup, not a good one.",
			tableCount: 0,
			scratchDatabase: scratch,
			durationMs,
		};
	}

	return {
		passed: true,
		detail: `Restored cleanly into a scratch database with ${tableCount} table${tableCount === 1 ? "" : "s"}.`,
		tableCount,
		scratchDatabase: scratch,
		durationMs,
	};
};
