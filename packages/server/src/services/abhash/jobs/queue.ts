import { Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { type AbhashJobActor, abhashJob } from "../../../db/schema";
import { connectionOptions, queuePrefix } from "./connection";
import {
	getJobDefinition,
	type JobRow,
	QUEUES,
	type QueueName,
} from "./registry";

export const cancelChannel = () => `${queuePrefix()}:jobs:cancel`;

export type QueuePayload =
	| { jobId: string }
	| {
			scheduled: {
				type: string;
				input: unknown;
				organizationId: string | null;
				scheduleId: string;
			};
	  };

const shared = globalThis as unknown as {
	__abhashQueues?: Map<QueueName, Queue<QueuePayload>>;
};
shared.__abhashQueues ??= new Map();
const queues = shared.__abhashQueues;

export const getQueue = (name: QueueName) => {
	let queue = queues.get(name);
	if (!queue) {
		queue = new Queue<QueuePayload>(name, {
			connection: connectionOptions("producer"),
			prefix: queuePrefix(),
		});
		// Without a listener ioredis errors surface as unhandled events.
		queue.on("error", () => {});
		queues.set(name, queue);
	}
	return queue;
};

export const redisClient = () => getQueue("abhash-infra").client;

export const isRedisReachable = async () => {
	try {
		const client = await redisClient();
		return (
			(await Promise.race([
				client.ping(),
				new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
			])) === "PONG"
		);
	} catch {
		return false;
	}
};

export class JobEngineUnavailableError extends Error {
	constructor(cause?: unknown) {
		super(
			"The job engine is unavailable: Redis cannot be reached. Deploys are not affected.",
			{ cause },
		);
	}
}

export interface EnqueueOptions {
	actor: AbhashJobActor;
	organizationId: string | null;
	parentId?: string;
	delayMs?: number;
}

export const enqueueJob = async (
	type: string,
	rawInput: unknown,
	options: EnqueueOptions,
): Promise<JobRow> => {
	const definition = getJobDefinition(type);
	if (!definition) throw new Error(`Unknown job type: ${type}`);
	const input = definition.input.parse(rawInput);
	const target = definition.target?.(input) ?? null;
	const [row] = await db
		.insert(abhashJob)
		.values({
			type,
			title: definition.title(input),
			organizationId: options.organizationId,
			actor: options.actor,
			input: input as Record<string, unknown>,
			targetType: target?.type,
			targetId: target?.id,
			parentId: options.parentId,
		})
		.returning();
	if (!row) throw new Error("Could not record the job");
	try {
		await getQueue(definition.queue).add(
			type,
			{ jobId: row.id },
			{
				jobId: row.id,
				delay: options.delayMs,
				attempts: definition.attempts ?? 1,
				backoff: { type: "exponential", delay: 10_000 },
				// Postgres keeps the history; Redis only needs the work in flight.
				removeOnComplete: true,
				removeOnFail: true,
			},
		);
	} catch (error) {
		await db
			.update(abhashJob)
			.set({
				status: "failed",
				error: "Job engine unavailable",
				finishedAt: new Date(),
			})
			.where(eq(abhashJob.id, row.id));
		throw new JobEngineUnavailableError(error);
	}
	return row;
};

/**
 * A queued job is removed from Redis right away; a running one is signalled
 * and stops at its next cancellation point, then records "cancelled".
 */
export const cancelJob = async (jobId: string) => {
	const row = await db.query.abhashJob.findFirst({
		where: eq(abhashJob.id, jobId),
	});
	if (!row) return false;
	if (row.status === "queued") {
		const definition = getJobDefinition(row.type);
		if (definition) {
			await getQueue(definition.queue)
				.remove(jobId)
				.catch(() => 0);
		}
		await db
			.update(abhashJob)
			.set({ status: "cancelled", finishedAt: new Date() })
			.where(and(eq(abhashJob.id, jobId), eq(abhashJob.status, "queued")));
		return true;
	}
	if (row.status === "running") {
		const client = await redisClient();
		await client.publish(cancelChannel(), jobId);
		return true;
	}
	return false;
};

/**
 * Jobs are never re-run after a crash: an infrastructure step may have been
 * half applied, so "running" rows left behind become "interrupted" and a
 * person (or agent) decides whether to retry. Queued rows whose Redis entry
 * is gone are marked the same way.
 */
export const reconcileJobs = async () => {
	const open = await db.query.abhashJob.findMany({
		where: inArray(abhashJob.status, ["queued", "running"]),
		columns: { id: true, type: true, status: true },
	});
	let interrupted = 0;
	for (const row of open) {
		const definition = getJobDefinition(row.type);
		const queued =
			row.status === "queued" && definition
				? await getQueue(definition.queue).getJob(row.id)
				: null;
		if (queued) continue;
		if (row.status === "running" && definition) {
			await getQueue(definition.queue)
				.remove(row.id)
				.catch(() => 0);
		}
		await db
			.update(abhashJob)
			.set({
				status: "interrupted",
				error: "Dokploy restarted while this job was pending or running",
				finishedAt: new Date(),
			})
			.where(eq(abhashJob.id, row.id));
		interrupted++;
	}
	return interrupted;
};

export const closeQueues = async () => {
	await Promise.all([...queues.values()].map((q) => q.close()));
	queues.clear();
};

export const queueNames = () => Object.keys(QUEUES) as QueueName[];
