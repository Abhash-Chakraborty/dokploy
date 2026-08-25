import { execAsyncRemote } from "../utils/process/execAsync";

export interface DockerUpgradeResult {
	serverId: string;
	previousVersion?: string;
	currentVersion?: string;
	/** Trimmed installer output, for surfacing what actually happened. */
	log: string;
}

/** `29.6.1`. The installer only accepts a plain three-part version. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Compares dotted numeric versions. Docker Engine versions are plain
 * `major.minor.patch`, so a component-wise numeric compare is exact — string
 * comparison is not (`29.10.0` sorts below `29.6.1`).
 */
export const compareDockerVersions = (a: string, b: string): number => {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
};

/** The newest version present in the fleet — the target every server aligns to. */
export const highestDockerVersion = (versions: string[]): string | undefined =>
	versions
		.filter((version) => VERSION_PATTERN.test(version))
		.sort(compareDockerVersions)
		.pop();

/**
 * The command run on the server. Deliberately the same installer Dokploy's own
 * server provisioning uses, pinned to an explicit version so every server in
 * the fleet lands on the same one rather than "whatever is latest today".
 *
 * Note this restarts the Docker daemon. Containers with a restart policy and
 * Swarm tasks come back on their own; anything without one does not.
 */
const upgradeScript = (targetVersion: string) => `
set -e

if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO_CMD="sudo"; else
    echo "Not running as root and sudo is unavailable."
    exit 1
  fi
else
  SUDO_CMD=""
fi

if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  echo "Docker is installed via snap, which Dokploy does not manage. Upgrade it with 'snap refresh docker'."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on this host; run server setup instead of an upgrade."
  exit 1
fi

echo "Current: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "Target:  ${targetVersion}"

curl -fsSL https://get.docker.com -o /tmp/dokploy-get-docker.sh
$SUDO_CMD sh /tmp/dokploy-get-docker.sh --version ${targetVersion}
rm -f /tmp/dokploy-get-docker.sh

# The installer restarts the daemon; give it a moment to accept connections
# again before we read the version back.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "Now: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
`;

const readVersion = async (serverId: string): Promise<string | undefined> => {
	try {
		const { stdout } = await execAsyncRemote(
			serverId,
			"docker version --format '{{.Server.Version}}' 2>/dev/null || true",
		);
		const version = stdout.trim();
		return version || undefined;
	} catch {
		return undefined;
	}
};

/**
 * Upgrades Docker Engine on one remote server to `targetVersion`.
 *
 * Only remote servers can be upgraded this way. The Dokploy host itself is not
 * reachable for this: the panel runs inside a container with the Docker socket
 * mounted, so it can talk to the host's daemon but has no shell on the host to
 * install packages with.
 */
export const upgradeDockerOnServer = async (
	serverId: string,
	targetVersion: string,
): Promise<DockerUpgradeResult> => {
	if (!VERSION_PATTERN.test(targetVersion)) {
		throw new Error(
			`"${targetVersion}" is not a Docker Engine version (expected e.g. 29.6.1).`,
		);
	}

	const previousVersion = await readVersion(serverId);

	// The installer prints progress to stderr; keep both streams so a failure is
	// explainable rather than silent.
	const { stdout, stderr } = await execAsyncRemote(
		serverId,
		upgradeScript(targetVersion),
	);

	const currentVersion = await readVersion(serverId);

	return {
		serverId,
		previousVersion,
		currentVersion,
		log: [stdout, stderr].filter(Boolean).join("\n").trim(),
	};
};
