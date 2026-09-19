import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { abhashBackupPolicy, abhashDrillPolicy } from "../../../db/schema";
import { defineJob } from "../jobs/registry";
import { removeSchedule, upsertSchedule } from "../jobs/scheduler";
import { runDrill } from "./drill";
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

/** Keeps the cron entries in step with the policies. */
export const syncBackupSchedule = async (
	organizationId: string,
	policyId: string,
) => {
	const { policy } = await findPolicy(organizationId, policyId);
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
