import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import {
	abhashServerMeta,
	type ServerFacts,
	type ServerHealth,
	server,
} from "../../../db/schema";
import { defineJob } from "../jobs/registry";
import { emitEvent } from "../webhooks";
import { execPooled, HostKeyMismatchError } from "./pool";

/** One round trip per server: everything the fleet table shows. */
export const FACTS_SCRIPT = [
	". /etc/os-release 2>/dev/null; echo os=${PRETTY_NAME:-unknown}",
	"echo kernel=$(uname -r)",
	"echo cores=$(nproc 2>/dev/null || echo 0)",
	"echo memory_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)",
	'echo disk_pct=$(df -P / | awk \'NR==2{gsub("%","",$5); print $5}\')',
	"echo load1=$(awk '{print $1}' /proc/loadavg)",
	"echo uptime=$(awk '{print int($1)}' /proc/uptime)",
	'echo docker=$(docker --version 2>/dev/null | awk \'{gsub(",",""); print $3}\')',
	"echo swarm=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)",
].join("; ");

export const parseFacts = (output: string): ServerFacts => {
	const values = new Map<string, string>();
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index > 0)
			values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
	}
	const num = (key: string) => {
		const value = Number(values.get(key));
		return Number.isFinite(value) ? value : undefined;
	};
	return {
		os: values.get("os") || undefined,
		kernel: values.get("kernel") || undefined,
		cpuCores: num("cores"),
		memoryMb: num("memory_mb"),
		diskUsedPercent: num("disk_pct"),
		load1: num("load1"),
		uptimeSeconds: num("uptime"),
		dockerVersion: values.get("docker") || undefined,
		swarm: values.get("swarm") || undefined,
		collectedAt: new Date().toISOString(),
	};
};

/** Degraded is "reachable but I would not deploy to it right now". */
export const healthFromFacts = (
	facts: ServerFacts,
): { health: ServerHealth; message: string | null } => {
	if ((facts.diskUsedPercent ?? 0) >= 90) {
		return {
			health: "degraded",
			message: `Disk ${facts.diskUsedPercent}% full`,
		};
	}
	if (facts.cpuCores && (facts.load1 ?? 0) > facts.cpuCores * 4) {
		return { health: "degraded", message: `Load ${facts.load1}` };
	}
	if (facts.swarm && facts.swarm !== "active" && facts.swarm !== "inactive") {
		return { health: "degraded", message: `Swarm ${facts.swarm}` };
	}
	return { health: "online", message: null };
};

export const ensureMeta = async (serverId: string, organizationId: string) => {
	await db
		.insert(abhashServerMeta)
		.values({ serverId, organizationId })
		.onConflictDoNothing();
	return db.query.abhashServerMeta.findFirst({
		where: eq(abhashServerMeta.serverId, serverId),
	});
};

export const collectFacts = async (
	serverId: string,
	organizationId: string,
) => {
	await ensureMeta(serverId, organizationId);
	try {
		const result = await execPooled(serverId, FACTS_SCRIPT, {
			timeoutMs: 20_000,
		});
		const facts = parseFacts(result.stdout);
		const { health, message } = healthFromFacts(facts);
		await db
			.update(abhashServerMeta)
			.set({
				facts,
				health,
				healthMessage: message,
				lastSeenAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(abhashServerMeta.serverId, serverId));
		return { health, facts };
	} catch (error) {
		const message =
			error instanceof HostKeyMismatchError
				? error.message
				: error instanceof Error
					? error.message
					: String(error);
		const previous = await db.query.abhashServerMeta.findFirst({
			where: eq(abhashServerMeta.serverId, serverId),
			columns: { health: true },
		});
		await db
			.update(abhashServerMeta)
			.set({ health: "offline", healthMessage: message, updatedAt: new Date() })
			.where(eq(abhashServerMeta.serverId, serverId));
		// Only on the way down, so a server that stays offline is not noisy.
		if (previous?.health !== "offline") {
			await emitEvent(organizationId, "server.offline", { serverId, message });
		}
		return { health: "offline" as const, error: message };
	}
};

export const collectFactsJob = defineJob({
	type: "fleet.collect-facts",
	queue: "abhash-infra",
	input: z.object({ organizationId: z.string().optional() }),
	title: () => "Collect server facts",
	timeoutMs: 5 * 60_000,
	run: async ({ input, log }) => {
		const servers = await db.query.server.findMany({
			where: input.organizationId
				? and(
						eq(server.organizationId, input.organizationId),
						eq(server.serverStatus, "active"),
					)
				: eq(server.serverStatus, "active"),
			columns: { serverId: true, name: true, organizationId: true },
		});
		const results: Record<string, string> = {};
		// Serial: one SSH round trip per server, and the pool keeps the
		// connections warm for whatever runs next.
		for (const row of servers) {
			const result = await collectFacts(row.serverId, row.organizationId);
			results[row.name] = result.health;
			await log(`${row.name}: ${result.health}`);
		}
		return results;
	},
});
