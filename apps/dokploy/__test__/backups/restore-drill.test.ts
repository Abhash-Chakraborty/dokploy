import {
	buildDrillCommands,
	buildRestoreDrillScript,
	parseRestoreDrill,
	scratchDatabaseName,
} from "@dokploy/server/utils/restore/drill";
import { describe, expect, it } from "vitest";

const credentials = { databaseUser: "app", databasePassword: "s3cret" };

const script = (type: "postgres" | "mysql" | "mariadb") =>
	buildRestoreDrillScript({
		containerSearchCommand: 'CONTAINER_ID=$(docker ps -q | head -1)',
		rcloneCommand: "rclone cat :s3:bucket/dump.gz | gunzip",
		commands: buildDrillCommands(type, "dokploy_drill_abc", credentials),
	});

describe("scratch database naming", () => {
	it("is prefixed so an abandoned one is obvious", () => {
		expect(scratchDatabaseName("abc123")).toMatch(/^dokploy_drill_/);
	});

	it("strips anything that would need quoting in an identifier", () => {
		const name = scratchDatabaseName("Ab-C_1!2@3");
		expect(name).toMatch(/^[a-z0-9_]+$/);
	});

	it("bounds the length so it stays a legal identifier", () => {
		expect(scratchDatabaseName("x".repeat(80)).length).toBeLessThanOrEqual(30);
	});
});

describe("drill script", () => {
	it.each(["postgres", "mysql", "mariadb"] as const)(
		"only ever writes to the scratch database (%s)",
		(type) => {
			const out = script(type);
			// Every database the script names is either the scratch one or, for
			// postgres, the `postgres` maintenance database it has to connect to
			// in order to CREATE and DROP. The live database is never named.
			const named = [...out.matchAll(/-d ([a-z0-9_]+)/g)].map((m) => m[1]);
			const targets = [...out.matchAll(/DB_NAME=([a-z0-9_]+)/g)].map(
				(m) => m[1],
			);
			expect(new Set([...named, ...targets])).toEqual(
				new Set(
					type === "postgres"
						? ["postgres", "dokploy_drill_abc"]
						: ["dokploy_drill_abc"],
				),
			);
		},
	);

	it("bails out when no database container is running", () => {
		expect(script("postgres")).toContain("DRILL_ERROR: database container not found");
	});

	it("drops the scratch database from a trap, not an inline command", () => {
		// `trap '<cmd>'` breaks when <cmd> contains single quotes — POSIX sh
		// concatenates rather than nesting — which silently defeats the cleanup
		// on exactly the failed runs it exists for.
		const out = script("postgres");
		expect(out).toContain("trap drill_cleanup EXIT");
		expect(out).not.toMatch(/trap '.*docker exec/);
	});

	it("drops any leftover scratch database before creating one", () => {
		const out = script("postgres");
		expect(out.indexOf("drill_cleanup\n")).toBeLessThan(
			out.indexOf("CREATE DATABASE"),
		);
	});

	it("pipes the backup stream into the restore", () => {
		expect(script("postgres")).toContain(
			"rclone cat :s3:bucket/dump.gz | gunzip |",
		);
	});

	it("restores without owner so it lands in the scratch database cleanly", () => {
		expect(script("postgres")).toContain("--no-owner");
	});

	it("counts tables in the restored copy, not the live database", () => {
		expect(script("postgres")).toContain("-d dokploy_drill_abc -tAc");
	});

	it("uses mariadb's own client rather than the mysql one", () => {
		expect(script("mariadb")).toContain("mariadb -u");
		expect(script("mariadb")).not.toContain("mysql -u");
	});
});

describe("drill result", () => {
	it("passes when tables landed", () => {
		const result = parseRestoreDrill("scratch", "DRILL_TABLES:70", 1234);
		expect(result.passed).toBe(true);
		expect(result.tableCount).toBe(70);
		expect(result.detail).toContain("70 tables");
		expect(result.durationMs).toBe(1234);
	});

	it("singularises one table", () => {
		expect(parseRestoreDrill("s", "DRILL_TABLES:1").detail).toContain(
			"1 table.",
		);
	});

	it("fails an empty restore rather than calling it a pass", () => {
		// pg_restore can exit zero having restored nothing useful.
		const result = parseRestoreDrill("s", "DRILL_TABLES:0");
		expect(result.passed).toBe(false);
		expect(result.detail).toMatch(/empty backup/);
	});

	it("reports a missing container as a failure with its reason", () => {
		const result = parseRestoreDrill(
			"s",
			"DRILL_ERROR: database container not found",
		);
		expect(result.passed).toBe(false);
		expect(result.detail).toBe("database container not found");
	});

	it("refuses to call an unverifiable restore a pass", () => {
		const result = parseRestoreDrill("s", "some output, no marker");
		expect(result.passed).toBe(false);
		expect(result.detail).toMatch(/unproven/);
	});

	it("ignores restore noise before the marker", () => {
		const result = parseRestoreDrill(
			"s",
			"pg_restore: warning: something\nDRILL_TABLES:12",
		);
		expect(result.passed).toBe(true);
		expect(result.tableCount).toBe(12);
	});
});
