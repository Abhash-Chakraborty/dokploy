import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { abhashBackupPolicy, abhashDrillPolicy } from "../../../db/schema";
import { defineJob } from "../jobs/registry";
import { removeSchedule, upsertSchedule } from "../jobs/scheduler";
import { runDrill } from "./drill";
import {
	disableWal,
	enableWal,
	recoverInPlace,
	recoverToPointInTime,
	shipWal,
} from "./pitr";
import { checkRepository, findPolicy, runBackup } from "./service";

export const backupRunJob = defineJob({
	type: "backup.run",
	queue: "abhash-backup",
	input: z.object({ organizationId: z.string(), policyId: z.string() }),
	title: () => "Back up",
	timeoutMs: 8 * 60 * 60_000,
	lock: (input) => ({ key: `backup:${input.policyId}`, limit: 1 }),
	run: async ({ input, log, redact }) =>
		runBackup(input.organizationId, input.policyId, log, redact),
});

export const backupCheckJob = defineJob({
	type: "backup.check",
	queue: "abhash-backup",
	input: z.object({
		organizationId: z.string(),
		repositoryId: z.string(),
		serverId: z.string().nullable().default(null),
		readDataPercent: z.number().int().min(0).max(100).default(5),
	}),
	title: () => "Verify a backup repository",
	timeoutMs: 6 * 60 * 60_000,
	lock: (input) => ({ key: `repo:${input.repositoryId}`, limit: 1 }),
	run: async ({ input, log }) => {
		const result = await checkRepository(
			input.organizationId,
			input.repositoryId,
			input.serverId,
			input.readDataPercent,
		);
		await log(result.output);
		if (!result.ok) throw new Error("The repository did not pass its check");
		return { ok: true };
	},
});

export const drillRunJob = defineJob({
	type: "backup.drill",
	queue: "abhash-backup",
	input: z.object({ organizationId: z.string(), drillPolicyId: z.string() }),
	title: () => "Restore drill",
	timeoutMs: 4 * 60 * 60_000,
	lock: (input) => ({ key: `drill:${input.drillPolicyId}`, limit: 1 }),
	run: async ({ input, log, redact }) => {
		const result = await runDrill(
			input.organizationId,
			input.drillPolicyId,
			log,
			redact,
		);
		if (result.status === "failed") {
			throw new Error(
				`The drill failed: ${result.checks
					.filter((check) => !check.ok)
					.map((check) => `${check.name} (${check.detail})`)
					.join("; ")}`,
			);
		}
		return result;
	},
});

export const walEnableJob = defineJob({
	type: "backup.walEnable",
	queue: "abhash-backup",
	input: z.object({ organizationId: z.string(), policyId: z.string() }),
	title: () => "Turn on WAL archiving",
	timeoutMs: 30 * 60_000,
	// It redeploys the database once, which drops connections.
	destructive: true,
	lock: (input) => ({ key: `backup:${input.policyId}`, limit: 1 }),
	run: async ({ input, log, redact }) => {
		await enableWal(input.organizationId, input.policyId, log);
		await syncBackupSchedule(input.organizationId, input.policyId);
		// Recovery needs a physical base to replay onto, so take it now.
		const backup = await runBackup(
			input.organizationId,
			input.policyId,
			log,
			redact,
		);
		await shipWal(input.organizationId, input.policyId, log, redact, {
			switchSegment: true,
		});
		return backup;
	},
});

export const walShipJob = defineJob({
	type: "backup.walShip",
	queue: "abhash-backup",
	input: z.object({ organizationId: z.string(), policyId: z.string() }),
	title: () => "Ship WAL",
	timeoutMs: 60 * 60_000,
	ephemeral: true,
	lock: (input) => ({ key: `wal:${input.policyId}`, limit: 1 }),
	run: async ({ input, log, redact }) => {
		const outcome = await shipWal(
			input.organizationId,
			input.policyId,
			log,
			redact,
		);
		// A ship that worked but found a problem must stay visible.
		if (outcome.problem) throw new Error(outcome.problem);
		return outcome;
	},
});

export const pitrJob = defineJob({
	type: "backup.pitr",
	queue: "abhash-backup",
	input: z.object({
		organizationId: z.string(),
		policyId: z.string(),
		/** ISO time; null recovers as far as the WAL goes. */
		targetTime: z.string().datetime().nullable().default(null),
		/** Swap the result in for the live database, keeping the old data. */
		replaceService: z.boolean().default(false),
	}),
	title: (input) =>
		input.replaceService
			? "Recover the database to a point in time"
			: "Recover a copy to a point in time",
	timeoutMs: 12 * 60 * 60_000,
	destructive: (input) => input.replaceService,
	lock: (input) => ({ key: `backup:${input.policyId}`, limit: 1 }),
	run: async ({ input, log, redact }) => {
		if (!input.replaceService) {
			return recoverToPointInTime(
				input.organizationId,
				input.policyId,
				{ targetTime: input.targetTime, keepVolume: true },
				log,
				redact,
			);
		}
		const outcome = await recoverInPlace(
			input.organizationId,
			input.policyId,
			input.targetTime,
			log,
			redact,
		);
		// The recovered database is on a new timeline: start a new chain.
		await runBackup(input.organizationId, input.policyId, log, redact);
		return outcome;
	},
});

export const turnOffWal = async (organizationId: string, policyId: string) => {
	await disableWal(organizationId, policyId);
	await syncBackupSchedule(organizationId, policyId);
};

/** A deleted policy must take its schedules with it, or they fire forever. */
export const removeBackupSchedules = async (policyId: string) => {
	await removeSchedule("backup.run", `backup:${policyId}`).catch(() => false);
	await removeSchedule("backup.walShip", `wal:${policyId}`).catch(() => false);
};

/** Keeps the cron entries in step with the policies. */
export const syncBackupSchedule = async (
	organizationId: string,
	policyId: string,
) => {
	const { policy } = await findPolicy(organizationId, policyId);
	const walId = `wal:${policy.id}`;
	if (policy.walEnabled && policy.enabled) {
		await upsertSchedule({
			id: walId,
			type: "backup.walShip",
			input: { organizationId, policyId: policy.id },
			cron: `*/${Math.min(59, Math.max(1, policy.walShipMinutes))} * * * *`,
			organizationId,
		});
	} else {
		await removeSchedule("backup.walShip", walId).catch(() => false);
	}
	const id = `backup:${policy.id}`;
	if (!policy.cronExpression || !policy.enabled) {
		await removeSchedule("backup.run", id).catch(() => false);
		return false;
	}
	await upsertSchedule({
		id,
		type: "backup.run",
		input: { organizationId, policyId: policy.id },
		cron: policy.cronExpression,
		timezone: policy.timezone,
		organizationId,
	});
	return true;
};

export const syncDrillSchedule = async (
	organizationId: string,
	drillPolicyId: string,
) => {
	const drill = await db.query.abhashDrillPolicy.findFirst({
		where: eq(abhashDrillPolicy.id, drillPolicyId),
	});
	if (!drill) return false;
	const id = `drill:${drill.id}`;
	if (!drill.cronExpression || !drill.enabled) {
		await removeSchedule("backup.drill", id).catch(() => false);
		return false;
	}
	await upsertSchedule({
		id,
		type: "backup.drill",
		input: { organizationId, drillPolicyId: drill.id },
		cron: drill.cronExpression,
		timezone: drill.timezone,
		organizationId,
	});
	return true;
};

/** Re-registers every schedule after a restart. */
export const initBackupSchedules = async () => {
	const policies = await db.query.abhashBackupPolicy.findMany({
		where: eq(abhashBackupPolicy.enabled, true),
	});
	for (const policy of policies) {
		await syncBackupSchedule(policy.organizationId, policy.id).catch(
			() => false,
		);
	}
	const drills = await db.query.abhashDrillPolicy.findMany({
		where: eq(abhashDrillPolicy.enabled, true),
	});
	for (const drill of drills) {
		await syncDrillSchedule(drill.organizationId, drill.id).catch(() => false);
	}
};
