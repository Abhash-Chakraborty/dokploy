import {
	buildImageScanCommand,
	hasBlockingVulnerabilities,
	isValidImageReference,
	parseImageScan,
} from "@dokploy/server/services/image-scan";
import { describe, expect, it } from "vitest";

const report = (
	vulnerabilities: Record<string, string>[],
	prefix = "",
	suffix = "",
) =>
	prefix +
	JSON.stringify({
		ArtifactName: "img",
		Results: [{ Vulnerabilities: vulnerabilities }],
	}) +
	suffix;

const vuln = (
	id: string,
	Severity: string,
	FixedVersion = "",
	PkgName = "pkg",
) => ({
	VulnerabilityID: id,
	Severity,
	PkgName,
	InstalledVersion: "1.0.0",
	FixedVersion,
	Title: `${id} title`,
});

describe("image reference validation", () => {
	it.each([
		"alpine",
		"alpine:3",
		"node:18-alpine3.17",
		"ghcr.io/owner/repo:tag",
		"registry.example.com:5000/team/app:v1.2.3",
		`alpine@sha256:${"a".repeat(64)}`,
	])("accepts %s", (ref) => {
		expect(isValidImageReference(ref)).toBe(true);
	});

	it.each([
		"",
		"alpine; rm -rf /",
		"alpine && curl evil.sh",
		"alpine`whoami`",
		"alpine$(id)",
		"alpine|tee",
		"alpine\nrm -rf /",
	])("rejects %j", (ref) => {
		expect(isValidImageReference(ref)).toBe(false);
	});

	it("refuses to build a command for a rejected reference", () => {
		expect(() => buildImageScanCommand("alpine; rm -rf /")).toThrow(
			/valid image reference/,
		);
	});
});

describe("scan command", () => {
	it("caches the vulnerability database between scans", () => {
		expect(buildImageScanCommand("alpine:3")).toContain(
			"dokploy-trivy-cache:/root/.cache/trivy",
		);
	});

	it("asks Trivy for the report regardless of findings", () => {
		// Without this Trivy exits non-zero on findings and execAsync throws,
		// turning "the image has CVEs" into "the scan failed".
		expect(buildImageScanCommand("alpine:3")).toContain("--exit-code 0");
	});

	it("pins the scanner version so results are reproducible", () => {
		expect(buildImageScanCommand("alpine:3")).toMatch(
			/aquasec\/trivy:\d+\.\d+\.\d+/,
		);
	});
});

describe("scan parsing", () => {
	it("counts findings by severity", () => {
		const result = parseImageScan(
			"img",
			report([
				vuln("CVE-1", "CRITICAL"),
				vuln("CVE-2", "HIGH"),
				vuln("CVE-3", "HIGH"),
				vuln("CVE-4", "LOW"),
			]),
		);
		expect(result.scanned).toBe(true);
		expect(result.total).toBe(4);
		expect(result.counts).toMatchObject({ CRITICAL: 1, HIGH: 2, LOW: 1 });
	});

	it("lists fixable findings before unfixable ones", () => {
		// A HIGH you can fix today is more useful than a CRITICAL you can't.
		const result = parseImageScan(
			"img",
			report([vuln("CVE-nofix", "CRITICAL"), vuln("CVE-fix", "HIGH", "2.0.0")]),
		);
		expect(result.topFindings[0]?.id).toBe("CVE-fix");
		expect(result.topFindings[1]?.id).toBe("CVE-nofix");
	});

	it("orders by severity within the fixable group", () => {
		const result = parseImageScan(
			"img",
			report([
				vuln("CVE-low", "LOW", "1.1"),
				vuln("CVE-crit", "CRITICAL", "1.1"),
				vuln("CVE-med", "MEDIUM", "1.1"),
			]),
		);
		expect(result.topFindings.map((f) => f.id)).toEqual([
			"CVE-crit",
			"CVE-med",
			"CVE-low",
		]);
	});

	it("finds the report even when docker prepends pull output", () => {
		const result = parseImageScan(
			"img",
			report(
				[vuln("CVE-1", "HIGH")],
				"Unable to find image locally\nPulling from library\n",
			),
		);
		expect(result.scanned).toBe(true);
		expect(result.total).toBe(1);
	});

	it("treats an unrecognised severity as unknown rather than dropping it", () => {
		const result = parseImageScan("img", report([vuln("CVE-1", "WEIRD")]));
		expect(result.counts.UNKNOWN).toBe(1);
		expect(result.total).toBe(1);
	});

	it("handles a clean image", () => {
		const result = parseImageScan("img", report([]));
		expect(result.scanned).toBe(true);
		expect(result.total).toBe(0);
	});

	it("handles Trivy reporting a null vulnerability list", () => {
		const result = parseImageScan(
			"img",
			JSON.stringify({ Results: [{ Vulnerabilities: null }] }),
		);
		expect(result.scanned).toBe(true);
		expect(result.total).toBe(0);
	});

	it("caps the findings it returns", () => {
		const many = Array.from({ length: 120 }, (_, i) =>
			vuln(`CVE-${i}`, "HIGH", "1.1"),
		);
		const result = parseImageScan("img", report(many));
		expect(result.total).toBe(120);
		expect(result.topFindings).toHaveLength(50);
	});

	it("reports rather than throws when there's no report at all", () => {
		const result = parseImageScan("img", "docker: command not found");
		expect(result.scanned).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("reports rather than throws on malformed JSON", () => {
		const result = parseImageScan("img", "{ not valid json ]");
		expect(result.scanned).toBe(false);
	});
});

describe("promotion gate", () => {
	it("blocks on a critical finding", () => {
		expect(
			hasBlockingVulnerabilities(
				parseImageScan("img", report([vuln("CVE-1", "CRITICAL")])),
			),
		).toBe(true);
	});

	it("does not block on high and below", () => {
		expect(
			hasBlockingVulnerabilities(
				parseImageScan("img", report([vuln("CVE-1", "HIGH")])),
			),
		).toBe(false);
	});

	it("does not block when the scan itself failed — that's a different problem", () => {
		expect(hasBlockingVulnerabilities(parseImageScan("img", "garbage"))).toBe(
			false,
		);
	});
});
