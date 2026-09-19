import { setTimeout as sleep } from "node:timers/promises";
import { and, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { abhashJob } from "../../../db/schema";
import { removeJobLog } from "./logs";
import { defineJob } from "./registry";

const FINISHED = ["succeeded", "failed", "cancelled", "interrupted"] as const;

/** A harmless job for checking the engine end to end from the UI. */
export const echoJob = defineJob({
	type: "system.echo",
	queue: "abhash-infra",
	input: z.object({
		message: z.string().max(200).default("hello"),
		steps: z.number().int().min(1).max(60).default(5),
	}),
	title: () => "Job engine self-test",
	timeoutMs: 5 * 60_000,
	run: async ({ input, log, progress, signal }) => {
		for (let step = 1; step <= input.steps; step++) {
			signal.throwIfAborted();
			await log(`${input.message} (${step}/${input.steps})`);
			await progress((step / input.steps) * 100);
			await sleep(1_000, undefined, { signal });
		}
		return { steps: input.steps };
	},
});

export const JOB_RETENTION_DAYS = 30;

export const pruneJobsJob = defineJob({
	type: "system.prune-jobs",
	queue: "abhash-infra",
	input: z.object({
		olderThanDays: z
			.number()
			.int()
			.min(1)
			.max(3650)
			.default(JOB_RETENTION_DAYS),
	}),
	title: (input) => `Prune job history older than ${input.olderThanDays} days`,
	run: async ({ input, log }) => {
		const cutoff = new Date(Date.now() - input.olderThanDays * 86_400_000);
		const removed = await db
			.delete(abhashJob)
			.where(
				and(
					inArray(abhashJob.status, [...FINISHED]),
					lt(abhashJob.createdAt, cutoff),
				),
			)
			.returning({ id: abhashJob.id });
		for (const { id } of removed) await removeJobLog(id);
		await log(`Removed ${removed.length} jobs and their logs`);
		return { removed: removed.length };
	},
});
