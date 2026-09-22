import "../ansible/service";
import "../backups/jobs";
import "../webhooks";
import "../firewall/apply";
import "../fleet/crash-watch";
import "../fleet/jobs";
import "../mesh/jobs";
import "../ssh/facts";
import "../vault/credentials";
import { isFlagEnabled, setSetting } from "../flags";
import { JOB_RETENTION_DAYS } from "./builtin";
import { isRedisReachable } from "./queue";
import { upsertSchedule } from "./scheduler";
import { startJobWorkers, stopJobWorkers } from "./worker";

export * from "./builtin";
export * from "./logs";
export * from "./queue";
export * from "./registry";
export * from "./scheduler";
export * from "./worker";

const startEngine = async () => {
	await startJobWorkers();
	const { initBackupSchedules } = await import("../backups/jobs");
	await initBackupSchedules().catch(() => {});
	await upsertSchedule({
		id: "firewall.check-drift",
		type: "firewall.check-drift",
		input: {},
		cron: "23 * * * *",
		organizationId: null,
	});
	await upsertSchedule({
		id: "fleet.collect-facts",
		type: "fleet.collect-facts",
		input: {},
		// Every five minutes meant an SSH round to every server 288 times a day
		// to feed a dashboard nobody watches that closely.
		cron: "*/15 * * * *",
		organizationId: null,
	});
	await upsertSchedule({
		id: "containers.watch-crashes",
		type: "containers.watch-crashes",
		input: {},
		cron: "*/2 * * * *",
		organizationId: null,
	});
	await upsertSchedule({
		id: "system.prune-jobs",
		type: "system.prune-jobs",
		input: { olderThanDays: JOB_RETENTION_DAYS },
		cron: "17 3 * * *",
		organizationId: null,
	});
};

/**
 * Called once at startup. With the flag off (the default) nothing connects
 * to Redis, so an upgrade changes nothing until the owner turns this on.
 */
export const initAbhashJobs = async () => {
	if (!(await isFlagEnabled("jobs.enabled"))) return;
	if (!(await isRedisReachable())) {
		console.error(
			"[abhash-jobs] Redis is unreachable; background jobs are paused. Deploys are not affected.",
		);
		return;
	}
	await startEngine();
};

export const setJobEngineEnabled = async (enabled: boolean, userId: string) => {
	if (enabled) {
		if (!(await isRedisReachable())) {
			throw new Error(
				"Redis cannot be reached, so the job engine cannot start",
			);
		}
		await startEngine();
	} else {
		await stopJobWorkers();
	}
	await setSetting("jobs.enabled", enabled, userId);
};
