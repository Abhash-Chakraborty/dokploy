import { DelayedError, type Job, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { abhashJob } from "../../../db/schema";
import { connectionOptions, queuePrefix } from "./connection";
import { tryAcquire } from "./locks";
import { createJobLogger } from "./logs";
import {
	cancelChannel,
	type QueuePayload,
	queueNames,
	reconcileJobs,
	redisClient,
} from "./queue";
import { getJobDefinition, type JobRow, QUEUES } from "./registry";

const LOCK_RETRY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

const shared = globalThis as unknown as {
	__abhashWorkers?: {
		workers: Worker<QueuePayload>[];
		running: Map<string, AbortController>;
		unsubscribe: () => Promise<void>;
	} | null;
};

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const loadRow = async (job: Job<QueuePayload>): Promise<JobRow | null> => {
	const data = job.data;
	if ("jobId" in data) {
		return (
			(await db.query.abhashJob.findFirst({
				where: eq(abhashJob.id, data.jobId),
			})) ?? null
		);
	}
	// A scheduled run has no row until it fires.
	const { type, input, organizationId, scheduleId } = data.scheduled;
	const definition = getJobDefinition(type);
	if (!definition) return null;
	const parsed = definition.input.parse(input);
	const target = definition.target?.(parsed) ?? null;
	const [row] = await db
		.insert(abhashJob)
		.values({
			type,
			title: definition.title(parsed),
			organizationId,
			actor: { type: "schedule", id: scheduleId },
			input: parsed as Record<string, unknown>,
			targetType: target?.type,
			targetId: target?.id,
			scheduleId,
		})
		.returning();
	return row ?? null;
};

const runJob = async (
	job: Job<QueuePayload>,
	token: string | undefined,
	running: Map<string, AbortController>,
) => {
	const row = await loadRow(job);
	if (!row || row.status === "cancelled") return;
	const definition = getJobDefinition(row.type);
	if (!definition) {
		await db
			.update(abhashJob)
			.set({
				status: "failed",
				error: `No handler for job type ${row.type}`,
				finishedAt: new Date(),
			})
			.where(eq(abhashJob.id, row.id));
		return;
	}
	const input = definition.input.parse(row.input);

	const lock = definition.lock?.(input) ?? null;
	const lease = lock ? await tryAcquire(lock.key, lock.limit) : null;
	if (lock && !lease) {
		// Scheduled runs get their row on first pickup; keep that id.
		if (!("jobId" in job.data)) await job.updateData({ jobId: row.id });
		await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
		throw new DelayedError();
	}

	const controller = new AbortController();
	running.set(row.id, controller);
	const timeout = setTimeout(
		() => controller.abort(new Error("Timed out")),
		definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const secrets = new Set<string>();
	const log = createJobLogger(row.id, secrets);
	const startedAt = new Date();
	await db
		.update(abhashJob)
		.set({
			status: "running",
			startedAt,
			error: null,
			attempts: sql`${abhashJob.attempts} + 1`,
		})
		.where(eq(abhashJob.id, row.id));

	try {
		const result = await definition.run({
			job: { ...row, status: "running", startedAt },
			input,
			signal: controller.signal,
			log,
			progress: async (percent) => {
				await db
					.update(abhashJob)
					.set({ progress: Math.max(0, Math.min(100, Math.round(percent))) })
					.where(eq(abhashJob.id, row.id));
			},
			redact: (value) => {
				if (value) secrets.add(value);
			},
		});
		await db
			.update(abhashJob)
			.set({
				status: "succeeded",
				result: result ?? null,
				progress: 100,
				finishedAt: new Date(),
			})
			.where(eq(abhashJob.id, row.id));
	} catch (error) {
		const cancelled =
			controller.signal.aborted &&
			(controller.signal.reason as Error | undefined)?.message === "Cancelled";
		const willRetry =
			!cancelled && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
		await log(`ERROR: ${errorMessage(error)}`).catch(() => {});
		await db
			.update(abhashJob)
			.set({
				status: cancelled ? "cancelled" : willRetry ? "queued" : "failed",
				error: errorMessage(error),
				finishedAt: willRetry ? null : new Date(),
			})
			.where(eq(abhashJob.id, row.id));
		if (willRetry) throw error;
	} finally {
		clearTimeout(timeout);
		running.delete(row.id);
		await lease?.release();
	}
};

export const areJobWorkersRunning = () => !!shared.__abhashWorkers;

export const startJobWorkers = async () => {
	if (shared.__abhashWorkers) return;
	const running = new Map<string, AbortController>();
	await reconcileJobs();

	const subscriber = (await redisClient()).duplicate();
	subscriber.on("error", () => {});
	if (subscriber.status !== "ready") {
		await new Promise((resolve) => subscriber.once("ready", resolve));
	}
	await subscriber.subscribe(cancelChannel());
	subscriber.on("message", (_channel, jobId: string) => {
		running.get(jobId)?.abort(new Error("Cancelled"));
	});

	const workers = queueNames().map((name) => {
		const worker = new Worker<QueuePayload>(
			name,
			(job, token) => runJob(job, token, running),
			{
				connection: connectionOptions("worker"),
				prefix: queuePrefix(),
				concurrency: QUEUES[name].concurrency,
				// A job that lost its worker is failed, not silently re-run.
				maxStalledCount: 0,
			},
		);
		worker.on("error", (error) =>
			console.error(`[abhash-jobs] ${name}:`, errorMessage(error)),
		);
		return worker;
	});

	shared.__abhashWorkers = {
		workers,
		running,
		unsubscribe: async () => {
			await subscriber.quit().catch(() => {});
		},
	};
};

export const stopJobWorkers = async () => {
	const state = shared.__abhashWorkers;
	if (!state) return;
	shared.__abhashWorkers = null;
	for (const controller of state.running.values()) {
		controller.abort(new Error("Cancelled"));
	}
	await Promise.all(state.workers.map((w) => w.close()));
	await state.unsubscribe();
};
