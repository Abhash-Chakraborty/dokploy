import { execAsync, execAsyncRemote } from "../process/execAsync";
import { parseSizeToBytes } from "./utils";

export type PruneScope =
	| "containers"
	| "images"
	| "volumes"
	| "builders"
	| "system";

export interface PrunePreviewItem {
	/** What the user would recognise — a container name, image ref, volume name. */
	name: string;
	/** Secondary line: state, age, or why it qualifies. */
	detail: string;
	size: string;
	sizeBytes: number;
}

export interface PruneScopePreview {
	scope: Exclude<PruneScope, "system">;
	itemCount: number;
	reclaimableBytes: number;
	/** Capped sample for display; itemCount is the true total. */
	items: PrunePreviewItem[];
}

export interface PrunePreview {
	scopes: PruneScopePreview[];
	totalItems: number;
	totalReclaimableBytes: number;
	/** Set when Docker couldn't be reached; scopes will be empty. */
	error?: string;
}

const MAX_ITEMS_PER_SCOPE = 25;

interface DfImage {
	Repository?: string;
	Tag?: string;
	ID?: string;
	Containers?: string;
	Size?: string;
	CreatedSince?: string;
}
interface DfContainer {
	Names?: string;
	Image?: string;
	State?: string;
	Status?: string;
	Size?: string;
}
interface DfVolume {
	Name?: string;
	Links?: string;
	Size?: string;
	Driver?: string;
}
interface DfBuildCache {
	ID?: string;
	Description?: string;
	InUse?: boolean | string;
	Size?: string;
	LastUsedSince?: string;
	CacheType?: string;
}
interface DfOutput {
	Images?: DfImage[];
	Containers?: DfContainer[];
	Volumes?: DfVolume[];
	BuildCache?: DfBuildCache[];
}

const toCount = (value: string | undefined) => {
	const parsed = Number.parseInt(value ?? "", 10);
	// Docker reports "N/A" for images whose container count it can't determine;
	// treating that as "in use" keeps the preview conservative.
	return Number.isFinite(parsed) ? parsed : 1;
};

const isTruthy = (value: boolean | string | undefined) =>
	value === true || value === "true";

const build = (
	scope: PruneScopePreview["scope"],
	items: PrunePreviewItem[],
): PruneScopePreview => ({
	scope,
	itemCount: items.length,
	reclaimableBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
	items: items
		.slice()
		.sort((a, b) => b.sizeBytes - a.sizeBytes)
		.slice(0, MAX_ITEMS_PER_SCOPE),
});

const imageRef = (image: DfImage) => {
	const repo =
		image.Repository && image.Repository !== "<none>" ? image.Repository : "";
	const tag = image.Tag && image.Tag !== "<none>" ? image.Tag : "";
	if (repo && tag) return `${repo}:${tag}`;
	if (repo) return repo;
	return image.ID ?? "<untagged image>";
};

/**
 * Enumerates exactly what a prune would delete, without deleting anything.
 *
 * Docker has no `--dry-run` for prune, but `docker system df -v` reports the
 * same signals prune uses to decide: a container that isn't running, an image
 * with no containers attached, a volume with no links, and build cache that
 * isn't in use.
 */
export const getPrunePreview = async (
	serverId?: string | null,
): Promise<PrunePreview> => {
	const command = 'docker system df -v --format "{{json .}}"';

	let parsed: DfOutput;
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		parsed = JSON.parse(stdout.trim());
	} catch (error) {
		return {
			scopes: [],
			totalItems: 0,
			totalReclaimableBytes: 0,
			error:
				error instanceof Error
					? error.message
					: "Docker isn't reachable from the panel.",
		};
	}

	// `docker container prune` removes anything not running.
	const containers = build(
		"containers",
		(parsed.Containers ?? [])
			.filter((entry) => (entry.State ?? "").toLowerCase() !== "running")
			.map((entry) => ({
				name: entry.Names || entry.Image || "container",
				detail: entry.Status || entry.State || "stopped",
				size: entry.Size ?? "0B",
				sizeBytes: parseSizeToBytes(entry.Size ?? "0B"),
			})),
	);

	// `docker image prune --all` removes images with no container attached.
	const images = build(
		"images",
		(parsed.Images ?? [])
			.filter((entry) => toCount(entry.Containers) === 0)
			.map((entry) => ({
				name: imageRef(entry),
				detail: entry.CreatedSince
					? `unused · created ${entry.CreatedSince}`
					: "unused",
				size: entry.Size ?? "0B",
				sizeBytes: parseSizeToBytes(entry.Size ?? "0B"),
			})),
	);

	// `docker volume prune --all` removes volumes nothing links to. This is the
	// destructive one: these can hold real data.
	const volumes = build(
		"volumes",
		(parsed.Volumes ?? [])
			.filter((entry) => toCount(entry.Links) === 0)
			.map((entry) => ({
				name: entry.Name || "volume",
				detail: `no containers linked${entry.Driver ? ` · ${entry.Driver}` : ""}`,
				size: entry.Size ?? "0B",
				sizeBytes: parseSizeToBytes(entry.Size ?? "0B"),
			})),
	);

	// `docker builder prune --all` clears cache that isn't currently in use.
	const builders = build(
		"builders",
		(parsed.BuildCache ?? [])
			.filter((entry) => !isTruthy(entry.InUse))
			.map((entry) => ({
				name: entry.Description || entry.ID || "build cache",
				detail: entry.LastUsedSince
					? `last used ${entry.LastUsedSince}`
					: (entry.CacheType ?? "cache"),
				size: entry.Size ?? "0B",
				sizeBytes: parseSizeToBytes(entry.Size ?? "0B"),
			})),
	);

	const scopes = [containers, images, volumes, builders];

	return {
		scopes,
		totalItems: scopes.reduce((sum, scope) => sum + scope.itemCount, 0),
		totalReclaimableBytes: scopes.reduce(
			(sum, scope) => sum + scope.reclaimableBytes,
			0,
		),
	};
};
