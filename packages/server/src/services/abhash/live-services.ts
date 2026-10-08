import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { server } from "../../db/schema";
import { execAsync, execAsyncRemote } from "../../utils/process/execAsync";

export interface LiveCount {
	running: number;
	desired: number;
	/** A compose container docker reports as restarting. */
	restarting: number;
}

/**
 * One round trip per server: Swarm services (apps, databases, stacks) by
 * replica count, then compose containers by project label.
 */
export const LIVE_SERVICES_COMMAND = [
	"docker service ls --format '{{.Name}}|{{.Replicas}}' 2>/dev/null",
	"echo '---'",
	`docker ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}|{{.State}}' 2>/dev/null`,
	"true",
].join("; ");

const bump = (
	map: Record<string, LiveCount>,
	key: string,
	running: number,
	desired: number,
	restarting = 0,
) => {
	const entry = map[key] ?? { running: 0, desired: 0, restarting: 0 };
	entry.running += running;
	entry.desired += desired;
	entry.restarting += restarting;
	map[key] = entry;
};

export const parseLiveServices = (stdout: string) => {
	const map: Record<string, LiveCount> = {};
	const [swarm = "", compose = ""] = stdout.split(/^---$/m);
	for (const line of swarm.split("\n")) {
		const [name, replicas] = line.trim().split("|");
		const counts = replicas?.match(/^(\d+)\/(\d+)/);
		if (!name || !counts) continue;
		const running = Number(counts[1]);
		const desired = Number(counts[2]);
		bump(map, name, running, desired);
		// Stack services are named <appName>_<service>; roll them up.
		const stack = name.includes("_") ? name.split("_")[0] : undefined;
		if (stack) bump(map, stack, running, desired);
	}
	for (const line of compose.split("\n")) {
		const [project, state] = line.trim().split("|");
		if (!project || !state) continue;
		bump(
			map,
			project,
			state === "running" ? 1 : 0,
			// Exited one-off containers (migrations, init jobs) are not missing.
			state === "exited" || state === "created" ? 0 : 1,
			state === "restarting" ? 1 : 0,
		);
	}
	return map;
};

export const LOCAL_SERVER_KEY = "local";

/** Live counts keyed by server ("local" for the Dokploy host) and appName. */
export const getLiveServices = async (organizationId: string) => {
	const remotes = await db
		.select({ serverId: server.serverId })
		.from(server)
		.where(
			and(
				eq(server.organizationId, organizationId),
				eq(server.serverStatus, "active"),
				isNotNull(server.sshKeyId),
			),
		);

	const probe = async (serverId?: string) => {
		try {
			const { stdout } = serverId
				? await execAsyncRemote(serverId, LIVE_SERVICES_COMMAND)
				: await execAsync(LIVE_SERVICES_COMMAND);
			return parseLiveServices(stdout);
		} catch {
			return null;
		}
	};

	const [local, ...rest] = await Promise.all([
		probe(),
		...remotes.map((row) => probe(row.serverId)),
	]);
	const result: Record<string, Record<string, LiveCount> | null> = {
		[LOCAL_SERVER_KEY]: local ?? null,
	};
	remotes.forEach((row, index) => {
		result[row.serverId] = rest[index] ?? null;
	});
	return result;
};
