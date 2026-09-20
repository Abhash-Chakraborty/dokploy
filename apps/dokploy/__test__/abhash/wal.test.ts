import {
	ARCHIVE_SCRIPT_BODY,
	dataSubpathOf,
	enableArchivingCommand,
	findSegmentGap,
	parseArchiverStatus,
	prunableArchiveFiles,
	pruneArchiveCommand,
	recoverySettings,
	recoveryTargetTime,
} from "@dokploy/server/services/abhash/backups/wal";
import { describe, expect, it } from "vitest";

const segment = (timeline: number, high: number, low: number) =>
	[timeline, high, low]
		.map((part) => part.toString(16).toUpperCase().padStart(8, "0"))
		.join("");

describe("archive script", () => {
	it("never leaves a half-written segment under the real name", () => {
		expect(ARCHIVE_SCRIPT_BODY).toMatch(/gzip -1 -c "\$src" > "\$tmp"/);
		expect(ARCHIVE_SCRIPT_BODY).toMatch(/mv "\$tmp" "\$dest"/);
		expect(ARCHIVE_SCRIPT_BODY.indexOf("gzip -1")).toBeLessThan(
			ARCHIVE_SCRIPT_BODY.indexOf('mv "$tmp"'),
		);
	});

	it("accepts the same segment twice but refuses different bytes", () => {
		expect(ARCHIVE_SCRIPT_BODY).toContain("cmp -s");
		expect(ARCHIVE_SCRIPT_BODY).toContain("refusing to overwrite");
	});
});

describe("enableArchivingCommand", () => {
	const command = enableArchivingCommand(
		{ appName: "db", username: "o'brien", database: "app" },
		60,
	);

	it("raises wal_level only from minimal, so logical is left alone", () => {
		expect(command).toMatch(/= minimal \]; then .*wal_level = '"'"'replica/);
	});

	it("quotes what it is given", () => {
		expect(command).toContain(`-U 'o'"'"'brien'`);
	});
});

describe("parseArchiverStatus", () => {
	it("reads a healthy archiver", () => {
		expect(
			parseArchiverStatus(
				`on|f|${segment(1, 0, 9)}|2026-09-20T05:37:36Z|0||${segment(1, 0, 10)}|12|0\n`,
			),
		).toEqual({
			archiveMode: "on",
			pendingRestart: false,
			lastArchivedWal: segment(1, 0, 9),
			lastArchivedAt: "2026-09-20T05:37:36Z",
			failedCount: 0,
			lastFailedWal: null,
			currentWal: segment(1, 0, 10),
			lagSeconds: 12,
			pendingSegments: 0,
		});
	});

	it("reads one that has archived nothing and waits for a restart", () => {
		const status = parseArchiverStatus(`off|t|||0||${segment(1, 0, 1)}||0`);
		expect(status?.pendingRestart).toBe(true);
		expect(status?.lastArchivedWal).toBeNull();
		expect(status?.lagSeconds).toBeNull();
	});

	it("gives up on anything else", () => {
		expect(parseArchiverStatus("psql: error: connection refused")).toBeNull();
		expect(parseArchiverStatus("")).toBeNull();
	});
});

describe("prunableArchiveFiles", () => {
	const files = [
		`${segment(1, 0, 1)}.gz`,
		`${segment(1, 0, 2)}.00000028.backup.gz`,
		`${segment(1, 0, 2)}.gz`,
		`${segment(1, 0, 3)}.gz`,
		"00000002.history.gz",
		`${segment(2, 0, 3)}.gz`,
		".000000010000000000000004.123",
		"archive.sh",
		"",
	];

	it("takes what is older than the base and nothing else", () => {
		expect(prunableArchiveFiles(files, segment(1, 0, 3))).toEqual([
			`${segment(1, 0, 1)}.gz`,
			`${segment(1, 0, 2)}.00000028.backup.gz`,
			`${segment(1, 0, 2)}.gz`,
		]);
	});

	it("drops a finished timeline whole, but never a history file", () => {
		const prunable = prunableArchiveFiles(files, segment(2, 0, 3));
		expect(prunable).toContain(`${segment(1, 0, 3)}.gz`);
		expect(prunable).not.toContain("00000002.history.gz");
		expect(prunable).not.toContain(`${segment(2, 0, 3)}.gz`);
	});

	it("prunes nothing when it is not told where to stop", () => {
		expect(prunableArchiveFiles(files, "")).toEqual([]);
		expect(prunableArchiveFiles(files, "../../etc")).toEqual([]);
	});
});

describe("pruneArchiveCommand", () => {
	it("only ever names archive files", () => {
		const command = pruneArchiveCommand("db", [
			`${segment(1, 0, 1)}.gz`,
			"../../etc/passwd",
			"x; rm -rf /",
		]);
		expect(command).toContain(`${segment(1, 0, 1)}.gz`);
		expect(command).not.toContain("passwd");
		expect(command).not.toContain("rm -rf /");
	});

	it("is nothing at all when there is nothing to remove", () => {
		expect(pruneArchiveCommand("db", [])).toBeNull();
		expect(pruneArchiveCommand("db", ["nope"])).toBeNull();
	});
});

describe("findSegmentGap", () => {
	it("passes an unbroken run", () => {
		const files = [1, 2, 3, 4].map((low) => `${segment(1, 0, low)}.gz`);
		expect(findSegmentGap(files, segment(1, 0, 2))).toEqual({
			ok: true,
			last: segment(1, 0, 4),
		});
	});

	it("names the first hole", () => {
		const files = [1, 2, 4].map((low) => `${segment(1, 0, low)}.gz`);
		expect(findSegmentGap(files, segment(1, 0, 1))).toEqual({
			ok: false,
			missing: segment(1, 0, 3),
		});
	});

	it("ignores holes older than where recovery starts", () => {
		const files = [1, 3, 4].map((low) => `${segment(1, 0, low)}.gz`);
		expect(findSegmentGap(files, segment(1, 0, 3)).ok).toBe(true);
	});

	it("counts across the end of a logical file: FF is followed by 00", () => {
		const files = [
			`${segment(1, 0, 0xfe)}.gz`,
			`${segment(1, 0, 0xff)}.gz`,
			`${segment(1, 1, 0)}.gz`,
		];
		expect(findSegmentGap(files, segment(1, 0, 0xfe))).toEqual({
			ok: true,
			last: segment(1, 1, 0),
		});
		expect(
			findSegmentGap([files[0], files[2]] as string[], segment(1, 0, 0xfe)),
		).toEqual({
			ok: false,
			missing: segment(1, 0, 0xff),
		});
	});

	it("does not mistake another timeline's segments for its own", () => {
		const files = [`${segment(1, 0, 1)}.gz`, `${segment(2, 0, 3)}.gz`];
		expect(findSegmentGap(files, segment(1, 0, 1))).toEqual({
			ok: true,
			last: segment(1, 0, 1),
		});
	});

	it("is content when the base backup needs no archive at all", () => {
		expect(findSegmentGap([], segment(1, 0, 5))).toEqual({
			ok: true,
			last: null,
		});
	});
});

describe("recovery settings", () => {
	it("writes the target with a numeric offset, never a zone name", () => {
		expect(recoveryTargetTime(new Date("2026-09-20T05:51:56.058Z"))).toBe(
			"2026-09-20 05:51:56.058+00",
		);
	});

	it("switches archiving off in the copy", () => {
		const settings = recoverySettings({
			walRestorePath: "/wal-restore/wal-archive/wal",
			targetTime: new Date("2026-09-20T05:51:56.058Z"),
		});
		expect(settings).toContain("archive_mode = 'off'");
		expect(settings).toContain(
			"recovery_target_time = '2026-09-20 05:51:56.058+00'",
		);
		expect(settings.startsWith("# abhash point-in-time recovery\n")).toBe(true);
	});

	it("sets no target when asked for the latest moment", () => {
		expect(
			recoverySettings({ walRestorePath: "/w", targetTime: null }),
		).not.toContain("recovery_target_time =");
	});
});

describe("dataSubpathOf", () => {
	it("is empty while PGDATA is the mount itself", () => {
		expect(
			dataSubpathOf("/var/lib/postgresql/data", "/var/lib/postgresql/data"),
		).toBe("");
	});

	it("finds the directory Postgres 18 nests its data in", () => {
		expect(
			dataSubpathOf("/var/lib/postgresql/18/docker", "/var/lib/postgresql"),
		).toBe("18/docker");
	});

	it("refuses a PGDATA that is not in the volume", () => {
		expect(() => dataSubpathOf("/data", "/var/lib/postgresql")).toThrow();
		expect(() =>
			dataSubpathOf("/var/lib/postgresql-other", "/var/lib/postgresql"),
		).toThrow();
	});
});
