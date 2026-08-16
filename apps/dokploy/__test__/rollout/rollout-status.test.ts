import { parseRolloutStatus } from "@dokploy/server/services/rollout";
import { describe, expect, it } from "vitest";

/** Builds probe output in the shape the shell actually emits. */
const probe = (
	replicas: string,
	update: unknown,
	tasks: Record<string, string>[] = [],
) =>
	JSON.stringify({
		replicas,
		update,
		tasks: Buffer.from(
			tasks.map((task) => JSON.stringify(task)).join("\n"),
			"utf8",
		).toString("base64"),
	});

const failedTask = (name: string, error: string, ago = "20 seconds ago") => ({
	Name: name,
	CurrentState: `Failed ${ago}`,
	DesiredState: "Shutdown",
	// Docker wraps the error in its own quotes inside the JSON field.
	Error: `"${error}"`,
});

describe("rollout status", () => {
	it("calls a fully converged service healthy", () => {
		const status = parseRolloutStatus("app", probe("2/2", null));
		expect(status.verdict).toBe("healthy");
		expect(status.detail).toBe("All 2 replicas running.");
		expect(status.runningReplicas).toBe(2);
		expect(status.desiredReplicas).toBe(2);
	});

	it("singularises a one-replica service", () => {
		expect(parseRolloutStatus("app", probe("1/1", null)).detail).toBe(
			"All 1 replica running.",
		);
	});

	it("reports a silent Swarm rollback, which is otherwise invisible", () => {
		const status = parseRolloutStatus(
			"app",
			probe("2/2", {
				State: "rollback_completed",
				Message: "rollback completed",
			}),
		);
		expect(status.verdict).toBe("rolled_back");
		expect(status.detail).toMatch(/never became healthy/);
		expect(status.updateState).toBe("rollback_completed");
	});

	it("treats a rollback in progress as a rollback", () => {
		expect(
			parseRolloutStatus("app", probe("1/2", { State: "rollback_started" }))
				.verdict,
		).toBe("rolled_back");
	});

	it("surfaces the task error when replicas never come up", () => {
		const status = parseRolloutStatus(
			"app",
			probe("0/2", null, [
				failedTask(
					"app.1",
					"task: non-zero exit (137): dockerexec: unhealthy container",
				),
			]),
		);
		expect(status.verdict).toBe("failing");
		expect(status.detail).toContain("Only 0/2 replicas running");
		expect(status.detail).toContain("unhealthy container");
		expect(status.recentFailures[0]?.error).toBe(
			"task: non-zero exit (137): dockerexec: unhealthy container",
		);
	});

	it("strips Docker's quoting from the task error", () => {
		const status = parseRolloutStatus(
			"app",
			probe("0/1", null, [failedTask("app.1", "boom")]),
		);
		expect(status.recentFailures[0]?.error).toBe("boom");
	});

	it("caps the failure list so one crash-loop can't flood the UI", () => {
		const tasks = Array.from({ length: 12 }, (_, i) =>
			failedTask(`app.${i}`, "boom"),
		);
		expect(
			parseRolloutStatus("app", probe("0/2", null, tasks)).recentFailures,
		).toHaveLength(5);
	});

	it("reports an in-progress update as converging", () => {
		const status = parseRolloutStatus(
			"app",
			probe("1/3", { State: "updating" }),
		);
		expect(status.verdict).toBe("converging");
		expect(status.detail).toContain("1/3");
	});

	it("reports a paused update with Swarm's own message", () => {
		const status = parseRolloutStatus(
			"app",
			probe("1/3", {
				State: "paused",
				Message: "update paused due to failure",
			}),
		);
		expect(status.verdict).toBe("failing");
		expect(status.detail).toBe("update paused due to failure");
	});

	it("distinguishes a missing service from a broken one", () => {
		const status = parseRolloutStatus("app", '{"replicas":"","update":null}');
		expect(status.verdict).toBe("missing");
		expect(status.detail).toMatch(/No Swarm service named app/);
	});

	it("treats a service scaled to zero as not running, not failing", () => {
		expect(parseRolloutStatus("app", probe("0/0", null)).verdict).toBe(
			"missing",
		);
	});

	it("still parses replicas when Swarm appends its own note", () => {
		const status = parseRolloutStatus(
			"app",
			probe("3/3 (max 2 per node)", null),
		);
		expect(status.runningReplicas).toBe(3);
		expect(status.desiredReplicas).toBe(3);
		expect(status.verdict).toBe("healthy");
	});

	it("mentions earlier failures on a service that recovered", () => {
		const status = parseRolloutStatus(
			"app",
			probe("2/2", null, [failedTask("app.1", "boom")]),
		);
		expect(status.verdict).toBe("healthy");
		expect(status.detail).toMatch(/after 1 earlier task failure/);
	});

	it("degrades rather than throwing on unparseable output", () => {
		const status = parseRolloutStatus("app", "not json");
		expect(status.verdict).toBe("unknown");
	});

	it("reads the last line, ignoring shell noise before it", () => {
		const status = parseRolloutStatus(
			"app",
			`warning: something\n${probe("2/2", null)}`,
		);
		expect(status.verdict).toBe("healthy");
	});
});
