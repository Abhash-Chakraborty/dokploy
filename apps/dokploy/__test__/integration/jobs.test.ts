import { setTimeout as sleep } from "node:timers/promises";
import { db } from "@dokploy/server/db";
import { abhashJob } from "@dokploy/server/db/schema";
import {
	cancelJob,
	closeQueues,
	defineJob,
	enqueueJob,
	readJobLog,
	reconcileJobs,
	startJobWorkers,
	stopJobWorkers,
} from "@dokploy/server/services/abhash/jobs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

process.env.ABHASH_JOBS_PREFIX = `abhash-test-${process.pid}`;

if (!process.env.REDIS_URL?.startsWith("redis://127.0.0.1:")) {
	throw new Error("REDIS_URL must point at the loopback sandbox Redis");
}

const actor = { type: "system" as const, name: "integration-test" };

const waitFor = async (id: string, statuses: string[], timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = await db.query.abhashJob.findFirst({
			where: eq(abhashJob.id, id),
		});
		if (row && statuses.includes(row.status)) return row;
		await sleep(200);
	}
	throw new Error(`job ${id} did not reach ${statuses.join("/")}`);
};

let concurrent = 0;
let maxConcurrent = 0;

defineJob({
	type: "test.locked",
	queue: "abhash-infra",
	input: z.object({ server: z.string() }),
	title: (input) => `locked ${input.server}`,
	lock: (input) => ({ key: `test:${input.server}`, limit: 1 }),
	run: async () => {
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await sleep(700);
		concurrent--;
		return null;
	},
});

defineJob({
	type: "test.secret",
	queue: "abhash-infra",
	input: z.object({}),
	title: () => "secret",
	run: async ({ log, redact }) => {
		redact("s3cr3t-value");
		await log("connecting with s3cr3t-value");
		return { ok: true };
	},
});

defineJob({
	type: "test.fail",
	queue: "abhash-infra",
	input: z.object({}),
	title: () => "fail",
	run: async () => {
		throw new Error("boom");
	},
});

describe("job engine", () => {
	beforeAll(async () => {
		await startJobWorkers();
	});

	afterAll(async () => {
		await stopJobWorkers();
		await closeQueues();
	});

	it("runs a job to completion and records its log and result", async () => {
		const job = await enqueueJob(
			"system.echo",
			{ message: "hi", steps: 2 },
			{ actor, organizationId: null },
		);
		const done = await waitFor(job.id, ["succeeded", "failed"]);
		expect(done.status).toBe("succeeded");
		expect(done.result).toEqual({ steps: 2 });
		expect(done.progress).toBe(100);
		const log = await readJobLog(job.id);
		expect(log.text).toContain("hi (1/2)");
		expect(log.text).toContain("hi (2/2)");
	});

	it("rejects input that fails the job's schema", async () => {
		await expect(
			enqueueJob(
				"system.echo",
				{ steps: 1000 },
				{ actor, organizationId: null },
			),
		).rejects.toThrow();
	});

	it("records failures with the error message", async () => {
		const job = await enqueueJob(
			"test.fail",
			{},
			{ actor, organizationId: null },
		);
		const done = await waitFor(job.id, ["failed"]);
		expect(done.error).toBe("boom");
	});

	it("redacts registered secrets from the log", async () => {
		const job = await enqueueJob(
			"test.secret",
			{},
			{ actor, organizationId: null },
		);
		await waitFor(job.id, ["succeeded"]);
		const log = await readJobLog(job.id);
		expect(log.text).toContain("connecting with ••••");
		expect(log.text).not.toContain("s3cr3t-value");
	});

	it("cancels a running job", async () => {
		const job = await enqueueJob(
			"system.echo",
			{ steps: 30 },
			{ actor, organizationId: null },
		);
		await waitFor(job.id, ["running"]);
		expect(await cancelJob(job.id)).toBe(true);
		const done = await waitFor(job.id, ["cancelled", "failed", "succeeded"]);
		expect(done.status).toBe("cancelled");
	});

	it("cancels a queued job before it starts", async () => {
		const job = await enqueueJob(
			"system.echo",
			{ steps: 1 },
			{ actor, organizationId: null, delayMs: 60_000 },
		);
		expect(await cancelJob(job.id)).toBe(true);
		const row = await waitFor(job.id, ["cancelled"]);
		expect(row.finishedAt).not.toBeNull();
	});

	it("serialises jobs that share a lock key", async () => {
		maxConcurrent = 0;
		const jobs = await Promise.all(
			[1, 2, 3].map(() =>
				enqueueJob(
					"test.locked",
					{ server: "a" },
					{ actor, organizationId: null },
				),
			),
		);
		for (const job of jobs) await waitFor(job.id, ["succeeded"], 60_000);
		expect(maxConcurrent).toBe(1);
	});

	it("marks orphaned rows as interrupted instead of re-running them", async () => {
		const [row] = await db
			.insert(abhashJob)
			.values({
				type: "system.echo",
				title: "orphan",
				status: "running",
				actor,
				input: { steps: 1 },
			})
			.returning();
		await reconcileJobs();
		const after = await waitFor(row!.id, ["interrupted"]);
		expect(after.error).toMatch(/restarted/);
	});
});
