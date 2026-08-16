import { db } from "../db";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

export interface FleetServerRow {
	/** `null` for the Dokploy host itself, which has no server record. */
	serverId: string | null;
	name: string;
	ipAddress: string | null;
	serverType: "deploy" | "build" | "dokploy";
	reachable: boolean;
	/** Why the probe failed, when `reachable` is false. */
	error?: string;
	dockerVersion?: string;
	swarmState?: string;
	swarmRole?: string;
	traefikVersion?: string;
	containersRunning?: number;
	containersTotal?: number;
	diskUsedPercent?: number;
	memUsedPercent?: number;
	loadPerCore?: number;
	uptime?: string;
	kernel?: string;
	/** Physical capacity, for committed-vs-available comparisons. */
	cpuCores?: number;
	memoryTotalMb?: number;
	diskTotalMb?: number;
}

export interface FleetOverview {
	servers: FleetServerRow[];
	/** Values that differ across reachable servers, worth flagging. */
	drift: {
		dockerVersions: string[];
		traefikVersions: string[];
	};
}

const PROBE_TIMEOUT_MS = 12_000;

/**
 * One round trip per server. Every field is optional on purpose: a host part
 * way through provisioning answers some of these and not others, and a
 * half-filled row is far more useful than a failed request.
 */
const PROBE = `
docker_version=$(docker version --format "{{.Server.Version}}" 2>/dev/null || echo "")
swarm_state=$(docker info --format "{{.Swarm.LocalNodeState}}" 2>/dev/null || echo "")
swarm_role=$(docker info --format "{{if .Swarm.ControlAvailable}}manager{{else}}worker{{end}}" 2>/dev/null || echo "")
traefik_version=$(docker exec dokploy-traefik traefik version 2>/dev/null | awk '/Version:/ {print $2; exit}' || echo "")
containers_running=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
containers_total=$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')
disk_pct=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
mem_pct=$(free 2>/dev/null | awk '/Mem:/ {printf "%.0f", $3/$2*100}')
mem_total=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}')
disk_total=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $2}')
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo "")
uptime_s=$(uptime -p 2>/dev/null | sed 's/^up //' || echo "")
kernel=$(uname -r 2>/dev/null || echo "")
printf '{"dockerVersion":"%s","swarmState":"%s","swarmRole":"%s","traefikVersion":"%s","containersRunning":"%s","containersTotal":"%s","diskUsedPercent":"%s","memUsedPercent":"%s","memoryTotalMb":"%s","diskTotalMb":"%s","cores":"%s","load1":"%s","uptime":"%s","kernel":"%s"}' \\
  "$docker_version" "$swarm_state" "$swarm_role" "$traefik_version" "$containers_running" "$containers_total" "$disk_pct" "$mem_pct" "$mem_total" "$disk_total" "$cores" "$load1" "$uptime_s" "$kernel"
`;

interface RawProbe {
	dockerVersion: string;
	swarmState: string;
	swarmRole: string;
	traefikVersion: string;
	containersRunning: string;
	containersTotal: string;
	diskUsedPercent: string;
	memUsedPercent: string;
	memoryTotalMb: string;
	diskTotalMb: string;
	cores: string;
	load1: string;
	uptime: string;
	kernel: string;
}

const num = (value: string | undefined) => {
	const parsed = Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) ? parsed : undefined;
};

const text = (value: string | undefined) => {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
	Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(
				() => reject(new Error(`Probe timed out after ${ms / 1000}s`)),
				ms,
			),
		),
	]);

const probeOne = async (
	base: Pick<FleetServerRow, "serverId" | "name" | "ipAddress" | "serverType">,
): Promise<FleetServerRow> => {
	try {
		const { stdout } = await withTimeout(
			base.serverId
				? execAsyncRemote(base.serverId, PROBE)
				: execAsync(PROBE),
			PROBE_TIMEOUT_MS,
		);

		const raw = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as RawProbe;
		const cores = num(raw.cores) || 1;
		const load1 = num(raw.load1);

		return {
			...base,
			reachable: Boolean(text(raw.dockerVersion)),
			error: text(raw.dockerVersion)
				? undefined
				: "Docker didn't answer on this host.",
			dockerVersion: text(raw.dockerVersion),
			swarmState: text(raw.swarmState),
			swarmRole:
				text(raw.swarmState) === "active" ? text(raw.swarmRole) : undefined,
			traefikVersion: text(raw.traefikVersion),
			containersRunning: num(raw.containersRunning),
			containersTotal: num(raw.containersTotal),
			diskUsedPercent: num(raw.diskUsedPercent),
			memUsedPercent: num(raw.memUsedPercent),
			cpuCores: num(raw.cores),
			memoryTotalMb: num(raw.memoryTotalMb),
			diskTotalMb: num(raw.diskTotalMb),
			loadPerCore:
				load1 === undefined
					? undefined
					: Math.round((load1 / cores) * 100) / 100,
			uptime: text(raw.uptime),
			kernel: text(raw.kernel),
		};
	} catch (error) {
		return {
			...base,
			reachable: false,
			error:
				error instanceof Error ? error.message : "Could not reach this server.",
		};
	}
};

const distinct = (values: (string | undefined)[]) => [
	...new Set(values.filter((value): value is string => Boolean(value))),
];

/**
 * Probes every server in the organization at once, so drift and headroom are
 * visible as a fleet rather than one server page at a time.
 */
export const getFleetOverview = async (
	organizationId: string,
	{ includeLocal = true }: { includeLocal?: boolean } = {},
): Promise<FleetOverview> => {
	const servers = await db.query.server.findMany({
		where: (fields, { eq }) => eq(fields.organizationId, organizationId),
		columns: {
			serverId: true,
			name: true,
			ipAddress: true,
			serverType: true,
		},
	});

	const targets: Pick<
		FleetServerRow,
		"serverId" | "name" | "ipAddress" | "serverType"
	>[] = servers.map((entry) => ({
		serverId: entry.serverId,
		name: entry.name,
		ipAddress: entry.ipAddress,
		serverType: entry.serverType,
	}));

	if (includeLocal) {
		targets.unshift({
			serverId: null,
			name: "Dokploy host",
			ipAddress: null,
			serverType: "dokploy",
		});
	}

	const rows = await Promise.all(targets.map(probeOne));
	const reachable = rows.filter((row) => row.reachable);

	return {
		servers: rows,
		drift: {
			dockerVersions: distinct(reachable.map((row) => row.dockerVersion)),
			traefikVersions: distinct(reachable.map((row) => row.traefikVersion)),
		},
	};
};
