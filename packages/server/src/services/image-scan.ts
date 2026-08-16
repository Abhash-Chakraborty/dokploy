import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

/** Pinned so a scan result is reproducible and doesn't drift under you. */
export const TRIVY_IMAGE = "aquasec/trivy:0.74.0";

/** Named volume for Trivy's vulnerability DB — without it every scan re-downloads it. */
const TRIVY_CACHE_VOLUME = "dokploy-trivy-cache";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface Vulnerability {
	id: string;
	severity: Severity;
	packageName: string;
	installedVersion: string;
	/** Empty when upstream has no fix yet — the ones you can't action. */
	fixedVersion: string;
	title: string;
}

export interface ImageScanResult {
	image: string;
	scanned: boolean;
	error?: string;
	counts: Record<Severity, number>;
	total: number;
	/** Fixable issues first, then by severity — the actionable ones on top. */
	topFindings: Vulnerability[];
}

const EMPTY_COUNTS: Record<Severity, number> = {
	CRITICAL: 0,
	HIGH: 0,
	MEDIUM: 0,
	LOW: 0,
	UNKNOWN: 0,
};

const SEVERITY_ORDER: Severity[] = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
	"UNKNOWN",
];

const MAX_FINDINGS = 50;

/**
 * Docker reference grammar: registry host, path, tag and digest. Validating
 * against it beats quoting — a reference that doesn't match this isn't one we
 * should be passing to a shell at all.
 */
const IMAGE_REFERENCE =
	/^[a-zA-Z0-9][a-zA-Z0-9._-]*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

export const isValidImageReference = (image: string) =>
	image.length > 0 && image.length <= 512 && IMAGE_REFERENCE.test(image);

export const buildImageScanCommand = (image: string) => {
	if (!isValidImageReference(image)) {
		throw new Error(`Not a valid image reference: ${image}`);
	}
	return [
		"docker run --rm",
		`-v ${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`,
		"-v /var/run/docker.sock:/var/run/docker.sock",
		TRIVY_IMAGE,
		"image --scanners vuln --format json --quiet",
		// Trivy exits non-zero on findings unless told otherwise; we want the
		// report either way and decide severity ourselves.
		"--exit-code 0",
		image,
	].join(" ");
};

interface TrivyVulnerability {
	VulnerabilityID?: string;
	Severity?: string;
	PkgName?: string;
	InstalledVersion?: string;
	FixedVersion?: string;
	Title?: string;
	Description?: string;
}

interface TrivyResult {
	Vulnerabilities?: TrivyVulnerability[] | null;
}

const asSeverity = (value: string | undefined): Severity => {
	const upper = (value ?? "").toUpperCase();
	return (SEVERITY_ORDER as string[]).includes(upper)
		? (upper as Severity)
		: "UNKNOWN";
};

/**
 * Trivy prints its report as one JSON document, but the surrounding `docker
 * run` can prepend pull progress, so find the document rather than assuming
 * it starts at byte zero.
 */
const extractJson = (stdout: string): string | null => {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	return stdout.slice(start, end + 1);
};

export const parseImageScan = (
	image: string,
	stdout: string,
): ImageScanResult => {
	const json = extractJson(stdout);
	if (!json) {
		return {
			image,
			scanned: false,
			error: "Trivy produced no report.",
			counts: { ...EMPTY_COUNTS },
			total: 0,
			topFindings: [],
		};
	}

	let parsed: { Results?: TrivyResult[] | null };
	try {
		parsed = JSON.parse(json);
	} catch {
		return {
			image,
			scanned: false,
			error: "Could not parse Trivy's report.",
			counts: { ...EMPTY_COUNTS },
			total: 0,
			topFindings: [],
		};
	}

	const counts = { ...EMPTY_COUNTS };
	const findings: Vulnerability[] = [];

	for (const result of parsed.Results ?? []) {
		for (const entry of result.Vulnerabilities ?? []) {
			const severity = asSeverity(entry.Severity);
			counts[severity] += 1;
			findings.push({
				id: entry.VulnerabilityID ?? "unknown",
				severity,
				packageName: entry.PkgName ?? "unknown",
				installedVersion: entry.InstalledVersion ?? "",
				fixedVersion: entry.FixedVersion ?? "",
				title: entry.Title || entry.Description?.slice(0, 160) || "",
			});
		}
	}

	// Fixable first: an issue with a known fixed version is something you can
	// act on today, which matters more than raw severity when triaging.
	findings.sort((a, b) => {
		const aFixable = a.fixedVersion ? 0 : 1;
		const bFixable = b.fixedVersion ? 0 : 1;
		if (aFixable !== bFixable) return aFixable - bFixable;
		return (
			SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		);
	});

	return {
		image,
		scanned: true,
		counts,
		total: findings.length,
		topFindings: findings.slice(0, MAX_FINDINGS),
	};
};

/** True when the image has issues serious enough to block a promotion. */
export const hasBlockingVulnerabilities = (result: ImageScanResult) =>
	result.scanned && result.counts.CRITICAL > 0;

export const scanImage = async (
	image: string,
	serverId?: string | null,
): Promise<ImageScanResult> => {
	const command = buildImageScanCommand(image);
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		return parseImageScan(image, stdout);
	} catch (error) {
		return {
			image,
			scanned: false,
			error:
				error instanceof Error
					? error.message
					: "Could not run the scanner on this host.",
			counts: { ...EMPTY_COUNTS },
			total: 0,
			topFindings: [],
		};
	}
};
