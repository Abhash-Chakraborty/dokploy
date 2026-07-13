import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { spawnAsync } from "@dokploy/server/utils/process/spawnAsync";
import { and, eq } from "drizzle-orm";

import semver from "semver";
import { db } from "../db";
import { compose } from "../db/schema";
import {
	initializeStandaloneTraefik,
	initializeTraefikService,
	type TraefikOptions,
} from "../setup/traefik-setup";
export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

const DEFAULT_IMAGE_REPOSITORY = "ghcr.io/abhash-chakraborty/dokploy";
const DEFAULT_RELEASE_REPOSITORY = "Abhash-Chakraborty/dokploy";
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const RELEASE_REPOSITORY_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const IMAGE_REPOSITORY_PATTERN =
	/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

interface ReleaseCacheEntry {
	expiresAt: number;
	releaseTag: string | null;
}

export interface UpdateCheckDependencies {
	fetch: typeof globalThis.fetch;
	imageExists: (image: string) => Promise<boolean>;
	now: () => number;
}

const releaseCache = new Map<string, ReleaseCacheEntry>();

export const clearUpdateDataCache = () => releaseCache.clear();

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

/** Returns the image repository used for this fork's self-update flow. */
export const getDokployImageRepository = () => {
	const configured =
		process.env.DOKPLOY_UPDATE_IMAGE ||
		process.env.DOKPLOY_IMAGE_REPOSITORY ||
		DEFAULT_IMAGE_REPOSITORY;
	const repository = configured
		.trim()
		.replace(/@.+$/, "")
		.replace(/:[^/:]+$/, "");

	return IMAGE_REPOSITORY_PATTERN.test(repository)
		? repository
		: DEFAULT_IMAGE_REPOSITORY;
};

/** Returns the validated GitHub owner/repository used for stable releases. */
export const getDokployReleaseRepository = () => {
	const repository =
		process.env.DOKPLOY_RELEASE_REPOSITORY || DEFAULT_RELEASE_REPOSITORY;
	return RELEASE_REPOSITORY_PATTERN.test(repository)
		? repository
		: DEFAULT_RELEASE_REPOSITORY;
};

const imageExists = async (image: string) => {
	try {
		await spawnAsync("docker", ["manifest", "inspect", image]);
		return true;
	} catch {
		return false;
	}
};

const defaultUpdateCheckDependencies: UpdateCheckDependencies = {
	fetch: globalThis.fetch,
	imageExists,
	now: Date.now,
};

const validateReleaseTag = (tag: unknown) => {
	if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
		return null;
	}
	return semver.valid(tag) ? tag : null;
};

/** Builds the fixed, validated Swarm arguments for a custom stable release. */
export const getDokployUpdateArguments = (releaseTag: string) => {
	const validatedReleaseTag = validateReleaseTag(releaseTag);
	if (!validatedReleaseTag) {
		throw new Error("Invalid Dokploy release tag");
	}
	return [
		"service",
		"update",
		"--force",
		"--with-registry-auth",
		"--update-failure-action",
		"rollback",
		"--update-monitor",
		"60s",
		"--image",
		`${getDokployImageRepository()}:${validatedReleaseTag}`,
		"dokploy",
	];
};

const getLatestCustomReleaseTag = async (
	imageRepository: string,
	dependencies: UpdateCheckDependencies,
) => {
	const releaseRepository = getDokployReleaseRepository();
	const cacheKey = `${releaseRepository}|${imageRepository}`;
	const cached = releaseCache.get(cacheKey);
	if (cached && cached.expiresAt > dependencies.now()) {
		return cached.releaseTag;
	}

	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "dokploy-release-checker",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const githubToken = process.env.DOKPLOY_RELEASE_GITHUB_TOKEN;
	if (githubToken) {
		headers.Authorization = `Bearer ${githubToken}`;
	}

	let response: Response;
	try {
		response = await dependencies.fetch(
			`https://api.github.com/repos/${releaseRepository}/releases/latest`,
			{ headers },
		);
	} catch {
		console.warn("Unable to reach GitHub while checking for Dokploy updates");
		return null;
	}

	if (response.status === 404) {
		releaseCache.set(cacheKey, {
			expiresAt: dependencies.now() + RELEASE_CACHE_TTL_MS,
			releaseTag: null,
		});
		return null;
	}
	if (!response.ok) {
		console.warn(`GitHub release check failed with status ${response.status}`);
		return null;
	}

	let release: { draft?: boolean; prerelease?: boolean; tag_name?: unknown };
	try {
		release = (await response.json()) as typeof release;
	} catch {
		console.warn("GitHub returned invalid release data while checking updates");
		return null;
	}

	const releaseTag =
		release.draft || release.prerelease
			? null
			: validateReleaseTag(release.tag_name);
	const versionImageExists = releaseTag
		? await dependencies.imageExists(`${imageRepository}:${releaseTag}`)
		: false;
	const verifiedReleaseTag = versionImageExists ? releaseTag : null;

	releaseCache.set(cacheKey, {
		expiresAt: dependencies.now() + RELEASE_CACHE_TTL_MS,
		releaseTag: verifiedReleaseTag,
	});
	return verifiedReleaseTag;
};

/** Returns Dokploy docker service image digest */
export const getServiceImageDigest = async () => {
	let stdout = "";
	try {
		const result = await execAsync(
			"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
		);
		stdout = result.stdout;
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes("no such service: dokploy") ||
				error.message.includes("This node is not a swarm manager"))
		) {
			return null;
		}
		throw error;
	}

	const currentDigest = stdout.trim().split("@")[1];

	if (!currentDigest) {
		return null;
	}

	return currentDigest;
};

/** Returns the latest version and whether the current installation can update. */
export const getUpdateData = async (
	currentVersion: string,
	dependencies: UpdateCheckDependencies = defaultUpdateCheckDependencies,
): Promise<IUpdateData> => {
	try {
		const imageRepository = getDokployImageRepository();
		if (imageRepository !== "dokploy/dokploy") {
			const currentImageTag = getDokployImageTag();
			if (currentImageTag === "canary" || currentImageTag === "feature") {
				return DEFAULT_UPDATE_DATA;
			}

			const latestVersion = await getLatestCustomReleaseTag(
				imageRepository,
				dependencies,
			);
			const cleanedCurrent = semver.clean(currentVersion);
			const cleanedLatest = latestVersion ? semver.clean(latestVersion) : null;
			if (!latestVersion || !cleanedCurrent || !cleanedLatest) {
				return DEFAULT_UPDATE_DATA;
			}

			return {
				latestVersion,
				updateAvailable: semver.gt(cleanedLatest, cleanedCurrent),
			};
		}

		const baseUrl =
			"https://hub.docker.com/v2/repositories/dokploy/dokploy/tags";
		let url: string | null = `${baseUrl}?page_size=100`;
		let allResults: { digest: string; name: string }[] = [];

		// Fetch all tags from Docker Hub
		while (url) {
			const response = await fetch(url, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			});

			const data = (await response.json()) as {
				next: string | null;
				results: { digest: string; name: string }[];
			};

			allResults = allResults.concat(data.results);
			url = data?.next;
		}

		const currentImageTag = getDokployImageTag();

		// Special handling for canary and feature branches
		// For development versions (canary/feature), don't perform update checks
		// These are unstable versions that change frequently, and users on these
		// branches are expected to manually manage updates
		if (currentImageTag === "canary" || currentImageTag === "feature") {
			const currentDigest = await getServiceImageDigest();
			if (!currentDigest) {
				return DEFAULT_UPDATE_DATA;
			}
			const latestDigest = allResults.find(
				(t) => t.name === currentImageTag,
			)?.digest;
			if (!latestDigest) {
				return DEFAULT_UPDATE_DATA;
			}
			if (currentDigest !== latestDigest) {
				return {
					latestVersion: currentImageTag,
					updateAvailable: true,
				};
			}
			return {
				latestVersion: currentImageTag,
				updateAvailable: false,
			};
		}

		// For stable versions, use semver comparison
		// Find the "latest" tag and get its digest
		const latestTag = allResults.find((t) => t.name === "latest");

		if (!latestTag) {
			return DEFAULT_UPDATE_DATA;
		}

		// Find the versioned tag (v0.x.x) that has the same digest as "latest"
		const latestVersionTag = allResults.find(
			(t) => t.digest === latestTag.digest && t.name.startsWith("v"),
		);

		if (!latestVersionTag) {
			return DEFAULT_UPDATE_DATA;
		}

		const latestVersion = latestVersionTag.name;

		// Use semver to compare versions for stable releases
		const cleanedCurrent = semver.clean(currentVersion);
		const cleanedLatest = semver.clean(latestVersion);

		if (!cleanedCurrent || !cleanedLatest) {
			return DEFAULT_UPDATE_DATA;
		}

		// Check if the latest version is greater than the current version
		const updateAvailable = semver.gt(cleanedLatest, cleanedCurrent);

		return {
			latestVersion,
			updateAvailable,
		};
	} catch {
		console.warn("Unable to determine Dokploy update availability");
		return DEFAULT_UPDATE_DATA;
	}
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
	version?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		if (resourceName === "dokploy") {
			const currentImageTag = getDokployImageTag();
			let imageTag = version;
			if (currentImageTag === "canary" || currentImageTag === "feature") {
				imageTag = currentImageTag;
			}

			command = `docker service update --force --image ${getDokployImageRepository()}:${imageTag} ${resourceName}`;
		} else {
			command = `docker service update --force ${resourceName}`;
		}
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return "";
	}
	return JSON.parse(result)?.join("\n");
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	const seenPorts = new Set<string>();
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMappings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			// Take only the first mapping to avoid duplicates (IPv4 and IPv6)
			const firstMapping = containerPortMappings[0];
			if (firstMapping) {
				const publishedPort = Number.parseInt(firstMapping.HostPort, 10);
				const portKey = `${targetPort}-${publishedPort}-${protocol}`;
				if (!seenPorts.has(portKey)) {
					seenPorts.add(portKey);
					ports.push({
						targetPort: targetPort,
						publishedPort: publishedPort,
						protocol: protocol,
					});
				}
			}
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		// Check if port is in use by a Docker container
		const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^dokploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout: dockerOut } = serverId
			? await execAsyncRemote(serverId, dockerCommand)
			: await execAsync(dockerCommand);

		const container = dockerOut.trim();

		if (container) {
			return {
				isInUse: true,
				conflictingContainer: `container "${container}"`,
			};
		}

		// Check if port is in use by a host-level service (non-Docker)
		// Dokploy runs inside a container, so we spawn an ephemeral container
		// with --net=host to share the host's network stack and use nc -z to
		// check if something is listening on the port
		const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
		const { stdout: hostOut } = serverId
			? await execAsyncRemote(serverId, hostCommand)
			: await execAsync(hostCommand);

		if (hostOut.includes("in_use")) {
			return {
				isInUse: true,
				conflictingContainer: "a host-level service",
			};
		}

		return { isInUse: false };
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	const resourceType = await getDockerResourceType(
		"dokploy-traefik",
		input.serverId,
	);

	if (resourceType === "service") {
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else if (resourceType === "standalone") {
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});

		await reconnectServicesToTraefik(input.serverId);
	} else {
		throw new Error("Traefik resource type not found");
	}
};

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (!composeResult) {
		return;
	}
	let commands = "";

	for (const compose of composeResult) {
		commands += `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n`;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};
