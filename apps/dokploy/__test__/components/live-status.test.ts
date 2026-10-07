import { describe, expect, it } from "vitest";
import {
	ageInSeconds,
	deriveLiveState,
} from "@/components/shared/live-status";

const task = (state: string, currentState: string, error = "") => ({
	name: "svc.1",
	state,
	currentState,
	error,
});

describe("deriveLiveState", () => {
	it("reports a crash loop even though the deploy finished", () => {
		const state = deriveLiveState(
			[
				task("ready", "Assigned less than a second ago"),
				task("shutdown", "Failed 5 seconds ago", '"task: non-zero exit (1)"'),
				task("shutdown", "Failed 11 seconds ago", '"task: non-zero exit (1)"'),
			],
			"done",
		);
		expect(state.tone).toBe("restarting");
		expect(state.detail).toBe("task: non-zero exit (1)");
	});

	it("is running when every slot runs and nothing crashed lately", () => {
		expect(
			deriveLiveState(
				[
					task("running", "Running 32 minutes ago"),
					task("shutdown", "Shutdown 2 hours ago"),
				],
				"done",
			),
		).toEqual({ tone: "running", label: "Running" });
	});

	it("counts replicas", () => {
		expect(
			deriveLiveState(
				[task("running", "Running 3 minutes ago"), task("running", "Starting 2 seconds ago")],
				"done",
			).label,
		).toBe("Starting");
		expect(
			deriveLiveState(
				[task("running", "Running 3 minutes ago"), task("running", "Running 3 minutes ago")],
				"done",
			).label,
		).toBe("Running · 2/2");
	});

	it("ignores old crashes and normal redeploy shutdowns", () => {
		expect(
			deriveLiveState(
				[
					task("running", "Running 2 hours ago"),
					task("shutdown", "Failed 3 hours ago", '"task: non-zero exit (1)"'),
					task("shutdown", "Shutdown 2 hours ago"),
				],
				"done",
			).tone,
		).toBe("running");
	});

	it("is stopped when nothing is wanted, and deploying while a deploy runs", () => {
		expect(deriveLiveState([], "idle").tone).toBe("stopped");
		expect(deriveLiveState([], "error").tone).toBe("failed");
		expect(deriveLiveState([], "running").tone).toBe("deploying");
	});
});

describe("ageInSeconds", () => {
	it("reads docker's relative times", () => {
		expect(ageInSeconds("Failed less than a second ago")).toBe(0);
		expect(ageInSeconds("Failed 5 seconds ago")).toBe(5);
		expect(ageInSeconds("Running 32 minutes ago")).toBe(1920);
		expect(ageInSeconds("Running about an hour ago")).toBe(3600);
		expect(ageInSeconds("Running 2 days ago")).toBe(172_800);
	});
});
