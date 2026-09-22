import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	COOLDOWN_MS,
	type ContainerSnapshot,
	detectCrashLoops,
	emptyState,
	type Probe,
	parseProbe,
	type TaskSnapshot,
	WINDOW_MS,
} from "@dokploy/server/services/abhash/fleet/crash-detect";
import { describe, expect, it } from "vitest";

// Captured from a sandbox daemon running a swarm service that exits 7 and a
// restart=always container that exits 3.
const FIXTURE = readFileSync(
	join(__dirname, "fixtures", "crash-probe.txt"),
	"utf8",
);

const container = (
	overrides: Partial<ContainerSnapshot> = {},
): ContainerSnapshot => ({
	id: "c1",
	name: "web",
	status: "running",
	restartCount: 0,
	exitCode: 0,
	swarmService: "",
	composeProject: "shop-abc123",
	composeService: "web",
	...overrides,
});

const task = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	service: "api-xyz",
	state: "failed",
	at: 0,
	exitCode: 1,
	error: "task: non-zero exit (1)",
	...overrides,
});

const probe = (p: Partial<Probe>): Probe => ({
	containers: [],
	tasks: [],
	...p,
});

describe("parseProbe", () => {
	it("reads real probe output", () => {
		const parsed = parseProbe(FIXTURE);
		const loopy = parsed.containers.find((c) => c.name === "loopy");
		expect(loopy).toMatchObject({
			status: "restarting",
			exitCode: 3,
			swarmService: "",
			composeProject: "",
		});
		expect(loopy?.restartCount).toBeGreaterThan(0);
		expect(parsed.tasks.length).toBeGreaterThanOrEqual(3);
		for (const t of parsed.tasks) {
			expect(t.service).toBe("crashy");
			expect(t.state).toBe("failed");
			expect(t.exitCode).toBe(7);
			expect(t.at).toBeGreaterThan(Date.UTC(2026, 0, 1));
		}
		expect(
			parsed.containers.filter((c) => c.swarmService === "crashy").length,
		).toBeGreaterThan(0);
	});

	it("ignores noise and malformed lines", () => {
		expect(parseProbe("Error: no such object\nCTR|too|short\n\n")).toEqual({
			containers: [],
			tasks: [],
		});
	});

	it("keeps a task error that contains the separator", () => {
		const parsed = parseProbe("TASK|s1|failed|100|1|oops | really");
		expect(parsed.tasks[0]?.error).toBe("oops | really");
	});
});

describe("detectCrashLoops, restarting containers", () => {
	it("does not report on first sight, however high the count", () => {
		const { loops } = detectCrashLoops(
			probe({ containers: [container({ restartCount: 50 })] }),
			emptyState(),
			1_000,
		);
		expect(loops).toEqual([]);
	});

	it("reports once the count climbs by the threshold inside the window", () => {
		const first = detectCrashLoops(
			probe({ containers: [container({ restartCount: 2 })] }),
			emptyState(),
			1_000,
		);
		const second = detectCrashLoops(
			probe({ containers: [container({ restartCount: 5, exitCode: 137 })] }),
			first.state,
			1_000 + 4 * 60_000,
		);
		expect(second.loops).toHaveLength(1);
		expect(second.loops[0]).toMatchObject({
			failures: 3,
			exitCode: 137,
			group: { kind: "compose", appNames: ["shop-abc123"] },
		});
	});

	it("does not count restarts across an expired window", () => {
		const first = detectCrashLoops(
			probe({ containers: [container({ restartCount: 2 })] }),
			emptyState(),
			0,
		);
		const later = detectCrashLoops(
			probe({ containers: [container({ restartCount: 6 })] }),
			first.state,
			WINDOW_MS + 60_000,
		);
		expect(later.loops).toEqual([]);
	});

	it("reports a group once per cooldown", () => {
		let state = detectCrashLoops(
			probe({ containers: [container({ restartCount: 0 })] }),
			emptyState(),
			0,
		).state;
		const hit = detectCrashLoops(
			probe({ containers: [container({ restartCount: 4 })] }),
			state,
			60_000,
		);
		expect(hit.loops).toHaveLength(1);
		state = hit.state;
		const again = detectCrashLoops(
			probe({ containers: [container({ restartCount: 9 })] }),
			state,
			120_000,
		);
		expect(again.loops).toEqual([]);
		const afterCooldown = detectCrashLoops(
			probe({ containers: [container({ restartCount: 9 })] }),
			again.state,
			60_000 + COOLDOWN_MS + 1,
		);
		// The window reset, so it needs to climb again before it is reported.
		expect(afterCooldown.loops).toEqual([]);
	});
});

describe("detectCrashLoops, swarm tasks", () => {
	const now = 10 * 60_000;

	it("reports a service with repeated failed tasks", () => {
		const { loops } = detectCrashLoops(
			probe({
				tasks: [
					task({ at: now - 60_000 }),
					task({ at: now - 120_000 }),
					task({ at: now - 180_000, error: "oom" }),
				],
			}),
			emptyState(),
			now,
		);
		expect(loops).toHaveLength(1);
		expect(loops[0]?.group).toMatchObject({ kind: "swarm", label: "api-xyz" });
		expect(loops[0]?.failures).toBe(3);
	});

	it("ignores tasks shut down by a deploy, and old failures", () => {
		const { loops } = detectCrashLoops(
			probe({
				tasks: [
					task({ state: "shutdown", at: now - 1_000 }),
					task({ state: "shutdown", at: now - 2_000 }),
					task({ state: "shutdown", at: now - 3_000 }),
					task({ at: now - WINDOW_MS - 1 }),
					task({ at: now - WINDOW_MS - 2 }),
					task({ at: now - 1_000 }),
				],
			}),
			emptyState(),
			now,
		);
		expect(loops).toEqual([]);
	});

	it("maps a stack service to its stack's appName", () => {
		const { loops } = detectCrashLoops(
			probe({
				tasks: [1, 2, 3].map((n) =>
					task({ service: "mystack-q1w2e3_worker", at: now - n * 1_000 }),
				),
			}),
			emptyState(),
			now,
		);
		expect(loops[0]?.group.appNames).toEqual([
			"mystack-q1w2e3_worker",
			"mystack-q1w2e3",
		]);
	});

	it("does not treat swarm task containers as restarting containers", () => {
		const { loops } = detectCrashLoops(
			probe({
				containers: [container({ swarmService: "api-xyz", restartCount: 99 })],
			}),
			{ baselines: { c1: { count: 0, at: now } }, alerted: {} },
			now,
		);
		expect(loops).toEqual([]);
	});

	it("finds both loops in the captured sandbox output", () => {
		const parsed = parseProbe(FIXTURE);
		const newest = Math.max(...parsed.tasks.map((t) => t.at ?? 0));
		const loopy = parsed.containers.find((c) => c.name === "loopy");
		const baselineState = {
			baselines: {
				[loopy?.id as string]: {
					count: (loopy?.restartCount ?? 0) - 3,
					at: newest,
				},
			},
			alerted: {},
		};
		const { loops } = detectCrashLoops(parsed, baselineState, newest + 1_000);
		expect(loops.map((l) => l.group.label).sort()).toEqual(["crashy", "loopy"]);
	});
});
