import { eq } from "drizzle-orm";
import { z } from "zod";
import { IS_CLOUD } from "../../../constants";
import { db } from "../../../db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	member,
	mongo,
	mysql,
	postgres,
	redis,
	server,
} from "../../../db/schema";
import {
	type ContainerHealthAlert,
	sendContainerHealthNotifications,
} from "../../../utils/notifications/container-health";
import { execAsync } from "../../../utils/process/execAsync";
import { getDokployUrl } from "../../admin";
import { getSetting, setSetting } from "../flags";
import { defineJob } from "../jobs/registry";
import { execPooled } from "../ssh/pool";
import {
	type CrashLoop,
	detectCrashLoops,
	emptyState,
	PROBE_COMMAND,
	parseProbe,
	type WatchState,
} from "./crash-detect";

const STATE_KEY = "crashwatch.state";
const LOCAL = "dokploy-server";
const PROBE_TIMEOUT_MS = 30_000;

const SERVICE_TABLES = [
	["application", applications, "applicationId"],
	["compose", compose, "composeId"],
	["postgres", postgres, "postgresId"],
	["mysql", mysql, "mysqlId"],
	["mariadb", mariadb, "mariadbId"],
	["mongo", mongo, "mongoId"],
	["redis", redis, "redisId"],
	["libsql", libsql, "libsqlId"],
] as const;

interface ResolvedService {
	name: string;
	project: string;
	environment: string;
	organizationId: string;
	path: string;
}

const resolveService = async (
	appNames: string[],
): Promise<ResolvedService | null> => {
	for (const appName of appNames) {
		for (const [type, table, idColumn] of SERVICE_TABLES) {
			const [row] = await db
				.select()
				.from(table)
				.where(eq(table.appName, appName))
				.limit(1);
			if (!row) continue;
			const environment = await db.query.environments.findFirst({
				where: (env, { eq }) => eq(env.environmentId, row.environmentId),
				with: { project: true },
			});
			if (!environment) continue;
			const id = (row as Record<string, unknown>)[idColumn] as string;
			return {
				name: row.name,
				project: environment.project.name,
				environment: environment.name,
				organizationId: environment.project.organizationId,
				path: `/dashboard/project/${environment.projectId}/environment/${environment.environmentId}/services/${type}/${id}`,
			};
		}
	}
	return null;
};

type Target = {
	key: string;
	name: string;
	serverId: string | null;
	/** Who hears about containers Dokploy does not manage on this host. */
	fallbackOrganizationId: string | null;
};

const targets = async (): Promise<Target[]> => {
	const remote = await db.query.server.findMany({
		where: eq(server.serverStatus, "active"),
		columns: { serverId: true, name: true, organizationId: true },
	});
	const list: Target[] = remote.map((row) => ({
		key: row.serverId,
		name: row.name,
		serverId: row.serverId,
		fallbackOrganizationId: row.organizationId,
	}));
	if (!IS_CLOUD) {
		const owner = await db.query.member.findFirst({
			where: eq(member.role, "owner"),
			columns: { organizationId: true },
		});
		list.unshift({
			key: LOCAL,
			name: "Dokploy server",
			serverId: null,
			fallbackOrganizationId: owner?.organizationId ?? null,
		});
	}
	return list;
};

const probe = async (target: Target) => {
	if (!target.serverId) return (await execAsync(PROBE_COMMAND)).stdout;
	const result = await execPooled(target.serverId, PROBE_COMMAND, {
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	return result.stdout;
};

const toAlert = async (
	target: Target,
	loop: CrashLoop,
	baseUrl: string | null,
): Promise<{ organizationId: string | null; alert: ContainerHealthAlert }> => {
	const resolved = await resolveService(loop.group.appNames);
	return {
		organizationId: resolved?.organizationId ?? target.fallbackOrganizationId,
		alert: {
			serverName: target.name,
			service: resolved?.name ?? loop.group.label,
			project: resolved?.project,
			environment: resolved?.environment,
			detail: loop.detail,
			failures: loop.failures,
			exitCode: loop.exitCode,
			url: resolved && baseUrl ? `${baseUrl}${resolved.path}` : undefined,
		},
	};
};

export const crashWatchJob = defineJob({
	type: "containers.watch-crashes",
	queue: "abhash-infra",
	input: z.object({}).default({}),
	title: () => "Watch containers for crash loops",
	timeoutMs: 5 * 60_000,
	// Runs every two minutes; only a run that found something keeps history.
	ephemeral: (result) =>
		((result as { alerts?: unknown[] } | null)?.alerts?.length ?? 0) === 0,
	run: async ({ log }) => {
		const saved = await getSetting<Record<string, WatchState>>(STATE_KEY, {});
		const next: Record<string, WatchState> = {};
		const alerts: string[] = [];
		const failures: string[] = [];
		const baseUrl = await getDokployUrl().catch(() => null);
		const now = Date.now();

		for (const target of await targets()) {
			let stdout: string;
			try {
				stdout = await probe(target);
			} catch (error) {
				// Keep the last state so an unreachable server does not reset
				// its windows and hide a loop that was building up.
				const last = saved[target.key];
				if (last) next[target.key] = last;
				failures.push(target.name);
				await log(
					`${target.name}: probe failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			const { loops, state } = detectCrashLoops(
				parseProbe(stdout),
				saved[target.key] ?? emptyState(),
				now,
			);
			next[target.key] = state;
			for (const loop of loops) {
				const { organizationId, alert } = await toAlert(target, loop, baseUrl);
				alerts.push(`${target.name}: ${alert.service}`);
				await log(`${target.name}: ${alert.service}: ${loop.detail}`);
				if (!organizationId) {
					await log("  no organization owns it, so nobody was notified");
					continue;
				}
				const channels = await sendContainerHealthNotifications(
					organizationId,
					alert,
				);
				await log(
					channels
						? `  sent to ${channels} notification channel${channels === 1 ? "" : "s"}`
						: "  no notification channel has crash-loop alerts turned on",
				);
			}
		}

		await setSetting(STATE_KEY, next);
		return { alerts, unreachable: failures };
	},
});
