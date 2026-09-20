import {
	cidrContains,
	isCidr,
} from "@dokploy/server/services/abhash/firewall/cidr";
import { describe, expect, it } from "vitest";

describe("isCidr", () => {
	it("accepts addresses and ranges of both families", () => {
		for (const value of [
			"10.0.0.1",
			"10.0.0.0/8",
			"0.0.0.0/0",
			"192.168.1.1/32",
			"fd00::1",
			"fd00::/8",
			"::/0",
			"2001:db8::/128",
		]) {
			expect(isCidr(value), value).toBe(true);
		}
	});

	it("refuses everything else, shell syntax included", () => {
		for (const value of [
			"",
			"any",
			"10.0.0.0/33",
			"fd00::/129",
			"10.0.0.0/8/8",
			"10.0.0.0/",
			"10.0.0.0/-1",
			"10.0.0.0/8 ",
			"10.0.0.0/8;id",
			"$(id)",
			"10.0.0.256",
			"example.com",
			"10.0.0.0/0x8",
		]) {
			expect(isCidr(value), value).toBe(false);
		}
	});
});

describe("cidrContains", () => {
	it("finds an address inside a range", () => {
		expect(cidrContains("10.0.0.0/8", "10.1.2.3")).toBe(true);
		expect(cidrContains("10.0.0.0/8", "11.1.2.3")).toBe(false);
		expect(cidrContains("0.0.0.0/0", "8.8.8.8")).toBe(true);
		expect(cidrContains("10.1.2.3", "10.1.2.3")).toBe(true);
		expect(cidrContains("10.1.2.3/32", "10.1.2.4")).toBe(false);
	});

	it("finds a range inside a wider one, not the other way round", () => {
		expect(cidrContains("100.0.0.0/8", "100.97.0.0/16")).toBe(true);
		expect(cidrContains("100.97.0.0/16", "100.0.0.0/8")).toBe(false);
	});

	it("only calls other families equal to themselves", () => {
		expect(cidrContains("fd00::/8", "fd00::/8")).toBe(true);
		expect(cidrContains("fd00::/8", "fd00::1")).toBe(false);
	});
});
