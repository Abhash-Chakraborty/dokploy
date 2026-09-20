import type { z } from "zod";
import type { abhashJob } from "../../../db/schema";

export const QUEUES = {
	"abhash-infra": { concurrency: 8 },
	"abhash-backup": { concurrency: 2 },
	"abhash-ansible": { concurrency: 2 },
} as const;
export type QueueName = keyof typeof QUEUES;

export type JobRow = typeof abhashJob.$inferSelect;

export interface JobContext<I> {
	job: JobRow;
	input: I;
	/** Aborted on cancel or timeout; long-running steps must honour it. */
	signal: AbortSignal;
	log: (line: string) => Promise<void>;
	progress: (percent: number) => Promise<void>;
	/** Values that must never appear in this job's log, e.g. resolved secrets. */
	redact: (value: string) => void;
}

export interface JobDefinition<I = unknown> {
	type: string;
	queue: QueueName;
	input: z.ZodType<I>;
	title: (input: I) => string;
	target?: (input: I) => { type: string; id: string } | null;
	/**
	 * At most `limit` jobs holding the same key run at once, across all
	 * queues; others wait. Used for "one firewall change per server".
	 */
	lock?: (input: I) => { key: string; limit: number } | null;
	/**
	 * Needs a person's approval when an agent asks for it. A function lets a
	 * type be harmless in one shape and destructive in another, e.g. an
	 * Ansible run in check mode versus an apply.
	 */
	destructive?: boolean | ((input: I) => boolean);
	/** Infrastructure changes default to a single attempt. */
	attempts?: number;
	timeoutMs?: number;
	/**
	 * For jobs that run every few minutes: a scheduled run that succeeds
	 * leaves no history behind. Failures are always kept.
	 */
	ephemeral?: boolean;
	run: (ctx: JobContext<I>) => Promise<unknown>;
}

const shared = globalThis as unknown as {
	__abhashJobDefs?: Map<string, JobDefinition<unknown>>;
};
shared.__abhashJobDefs ??= new Map();
const definitions = shared.__abhashJobDefs;

export const defineJob = <I>(definition: JobDefinition<I>) => {
	definitions.set(
		definition.type,
		definition as unknown as JobDefinition<unknown>,
	);
	return definition;
};

export const getJobDefinition = (type: string) => definitions.get(type);

export const jobTypes = () => [...definitions.keys()].sort();
