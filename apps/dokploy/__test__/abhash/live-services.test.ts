import { parseLiveServices } from "@dokploy/server/services/abhash/live-services";
import { describe, expect, it } from "vitest";

describe("parseLiveServices", () => {
	const out = [
		"postgres-51mv-hnwbqh|1/1",
		"mongo-51mv-disscc|0/1",
		"web-x2k9|2/3 (max 1 per node)",
		"shop-ab12_api|1/1",
		"shop-ab12_worker|0/1",
		"---",
		"netbird-s30km3|running",
		"netbird-s30km3|running",
		"netbird-s30km3|restarting",
		"careeros-ul0v1z|exited",
		"",
	].join("\n");
	const live = parseLiveServices(out);

	it("reads swarm replica counts", () => {
		expect(live["postgres-51mv-hnwbqh"]).toEqual({
			running: 1,
			desired: 1,
			restarting: 0,
		});
		expect(live["mongo-51mv-disscc"]).toEqual({
			running: 0,
			desired: 1,
			restarting: 0,
		});
		expect(live["web-x2k9"]).toEqual({ running: 2, desired: 3, restarting: 0 });
	});

	it("rolls stack services up under the stack's appName", () => {
		expect(live["shop-ab12"]).toEqual({
			running: 1,
			desired: 2,
			restarting: 0,
		});
	});

	it("counts compose containers by project, ignoring exited one-offs", () => {
		expect(live["netbird-s30km3"]).toEqual({
			running: 2,
			desired: 3,
			restarting: 1,
		});
		expect(live["careeros-ul0v1z"]).toEqual({
			running: 0,
			desired: 0,
			restarting: 0,
		});
	});

	it("survives an empty probe", () => {
		expect(parseLiveServices("---\n")).toEqual({});
		expect(parseLiveServices("")).toEqual({});
	});
});
