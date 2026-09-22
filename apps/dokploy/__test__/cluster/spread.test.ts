import {
	applySpread,
	readSpread,
	spreadUpdateFlags,
} from "@dokploy/server/utils/cluster/spread";
import { describe, expect, it } from "vitest";

const spreadPref = { Spread: { SpreadDescriptor: "node.id" } };

describe("applySpread", () => {
	it("adds a node spread and a per-node cap to an empty placement", () => {
		expect(applySpread(null, { spread: true, maxPerNode: 2 }, false)).toEqual({
			Constraints: [],
			Preferences: [spreadPref],
			MaxReplicas: 2,
		});
	});

	it("keeps the managers-only default for services with volumes", () => {
		expect(applySpread(null, { spread: true }, true)).toEqual({
			Constraints: ["node.role==manager"],
			Preferences: [spreadPref],
		});
	});

	it("leaves constraints and other preferences alone", () => {
		const placement = {
			Constraints: ["node.labels.region==eu"],
			Preferences: [{ Spread: { SpreadDescriptor: "node.labels.zone" } }],
		};
		expect(applySpread(placement, { spread: true }, false)).toEqual({
			Constraints: ["node.labels.region==eu"],
			Preferences: [
				spreadPref,
				{ Spread: { SpreadDescriptor: "node.labels.zone" } },
			],
		});
	});

	it("does not duplicate the spread when saved twice", () => {
		const once = applySpread(null, { spread: true }, false);
		const twice = applySpread(once, { spread: true }, false);
		expect(twice?.Preferences).toEqual([spreadPref]);
	});

	it("removes spread and cap when switched off", () => {
		const on = applySpread(null, { spread: true, maxPerNode: 3 }, false);
		expect(applySpread(on, { spread: false, maxPerNode: 0 }, false)).toEqual({
			Constraints: [],
		});
	});

	it("returns null when nothing was set and nothing is asked for", () => {
		expect(applySpread(null, { spread: false }, true)).toBeNull();
		expect(applySpread(null, { spread: false }, false)).toBeNull();
	});
});

describe("readSpread", () => {
	it("reads back what applySpread wrote", () => {
		const placement = applySpread(null, { spread: true, maxPerNode: 4 }, false);
		expect(readSpread(placement)).toEqual({ spread: true, maxPerNode: 4 });
		expect(readSpread(null)).toEqual({ spread: false, maxPerNode: 0 });
	});
});

describe("spreadUpdateFlags", () => {
	it("maps to docker service update flags", () => {
		expect(spreadUpdateFlags({ spread: true, maxPerNode: 2 })).toEqual([
			"--placement-pref-add=spread=node.id",
			"--replicas-max-per-node=2",
		]);
		expect(spreadUpdateFlags({ spread: false })).toEqual([
			"--placement-pref-rm=spread=node.id",
			"--replicas-max-per-node=0",
		]);
	});
});
