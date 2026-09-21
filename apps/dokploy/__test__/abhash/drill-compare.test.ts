import {
	compareToLive,
	fingerprintCommand,
	parseFingerprint,
} from "@dokploy/server/services/abhash/backups/drill";
import { describe, expect, it } from "vitest";

const rows = (...pairs: [string, number][]) =>
	pairs.map(([name, r]) => ({ name, rows: r }));

describe("parseFingerprint", () => {
	it("reads tab separated name and count", () => {
		expect(parseFingerprint("users\t10\norders\t3\n")).toEqual(
			rows(["orders", 3], ["users", 10]),
		);
	});

	it("sorts by name so the two sides line up", () => {
		expect(parseFingerprint("z\t1\na\t2").map((r) => r.name)).toEqual([
			"a",
			"z",
		]);
	});

	it("drops blank lines and psql noise", () => {
		expect(parseFingerprint("\n\nusers\t4\n\n")).toEqual(rows(["users", 4]));
	});

	it("drops rows whose count is not a number", () => {
		expect(parseFingerprint("users\tnope\norders\t2")).toEqual(
			rows(["orders", 2]),
		);
	});
});

describe("compareToLive", () => {
	it("passes when the restore matches exactly", () => {
		const r = compareToLive(rows(["users", 5]), rows(["users", 5]));
		expect(r.ok).toBe(true);
		expect(r.detail).toContain("identical");
	});

	it("passes when the live database has moved on since the snapshot", () => {
		const r = compareToLive(rows(["users", 9]), rows(["users", 5]));
		expect(r.ok).toBe(true);
		expect(r.detail).toContain("written since the snapshot");
	});

	it("fails when a table is missing from the restore", () => {
		const r = compareToLive(
			rows(["users", 5], ["orders", 2]),
			rows(["users", 5]),
		);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("orders");
	});

	it("fails when a populated table came back empty", () => {
		const r = compareToLive(rows(["users", 5]), rows(["users", 0]));
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("empty in the restore");
	});

	it("allows a table that is empty on both sides", () => {
		expect(compareToLive(rows(["audit", 0]), rows(["audit", 0])).ok).toBe(true);
	});

	it("does not fail on extra tables in the restore", () => {
		// The snapshot predates a drop, which is not data loss.
		expect(
			compareToLive(rows(["users", 1]), rows(["users", 1], ["old", 7])).ok,
		).toBe(true);
	});

	it("fails when the live side reports nothing, rather than passing vacuously", () => {
		const r = compareToLive([], rows(["users", 5]));
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("no tables");
	});
});

describe("fingerprintCommand", () => {
	const target = { container: "c1", database: "app", username: "postgres" };

	it("counts postgres rows for real instead of reading an estimate", () => {
		const cmd = fingerprintCommand("postgres", target) ?? "";
		expect(cmd).toContain("query_to_xml");
		expect(cmd).not.toContain("reltuples");
		expect(cmd).not.toContain("n_live_tup");
	});

	it("scopes mysql to the target database", () => {
		const cmd = fingerprintCommand("mysql", target) ?? "";
		// The whole statement is wrapped for sh -c, so the inner quotes around
		// the database name come back shell-escaped rather than literal.
		expect(cmd).toContain(`table_schema = '"'"'app'"'"'`);
	});

	it("escapes a database or user name that carries a quote", () => {
		const nasty = {
			container: "c1",
			database: "app'; DROP TABLE users; --",
			username: "post'gres",
		};
		for (const kind of ["postgres", "mysql"] as const) {
			const cmd = fingerprintCommand(kind, nasty) ?? "";
			// Every quote from the input is escaped, so none of it can close the
			// surrounding shell quoting and start a new word.
			expect(cmd).not.toMatch(/[^"]'; DROP TABLE/);
			expect(cmd).toContain(`'"'"'`);
		}
	});

	it("has no command for kinds without tables", () => {
		expect(fingerprintCommand("volume", target)).toBeNull();
		expect(fingerprintCommand("path", target)).toBeNull();
	});
});
