import { planRetention } from "@dokploy/server/utils/backups/retention";
import { describe, expect, it } from "vitest";

const zip = (name: string) => /\.zip$/.test(name);

describe("planRetention", () => {
	it("deletes an expired backup together with its checksum", () => {
		const files = [
			"2026-10-08T01:00.zip",
			"2026-10-08T01:00.zip.sha256",
			"2026-10-08T00:00.zip",
			"2026-10-08T00:00.zip.sha256",
			"2026-10-07T23:00.zip",
			"2026-10-07T23:00.zip.sha256",
		];
		expect(planRetention(files, 2, zip).sort()).toEqual([
			"2026-10-07T23:00.zip",
			"2026-10-07T23:00.zip.sha256",
		]);
	});

	it("clears checksums left behind by earlier runs", () => {
		const files = [
			"2026-10-08T01:00.zip",
			"2026-10-08T01:00.zip.sha256",
			"2026-09-01T00:00.zip.sha256",
			"2026-09-02T00:00.zip.sha256",
		];
		expect(planRetention(files, 3, zip).sort()).toEqual([
			"2026-09-01T00:00.zip.sha256",
			"2026-09-02T00:00.zip.sha256",
		]);
	});

	it("keeps everything while under the limit and ignores blank lines", () => {
		expect(planRetention(["a.zip", "a.zip.sha256", "", "  "], 5, zip)).toEqual(
			[],
		);
	});

	it("leaves database dumps alone apart from the expired ones", () => {
		const dump = (name: string) => /\.sql\.gz$/.test(name);
		expect(
			planRetention(["3.sql.gz", "2.sql.gz", "1.sql.gz"], 2, dump),
		).toEqual(["1.sql.gz"]);
	});
});
