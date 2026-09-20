import { isMetricsUrlAllowed } from "@dokploy/server/services/abhash/metrics-endpoints";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	query: { server: { findMany: vi.fn() } },
}));
vi.mock("@dokploy/server/db", () => ({ db: mockDb }));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({
		serverIp: "203.0.113.10",
		metricsConfig: { server: { port: 4500 } },
	})),
}));

describe("isMetricsUrlAllowed", () => {
	beforeEach(() => {
		mockDb.query.server.findMany.mockResolvedValue([
			{ ipAddress: "198.51.100.7", metricsConfig: { server: { port: 4500 } } },
		]);
	});

	it.each([
		"http://203.0.113.10:4500/metrics",
		"http://198.51.100.7:4500/metrics?limit=50",
	])("accepts the organization's monitoring agent %s", async (url) => {
		expect(await isMetricsUrlAllowed(url, "org-1")).toBe(true);
	});

	it.each([
		"http://169.254.169.254/latest/meta-data",
		"http://203.0.113.10:5432/",
		"http://127.0.0.1:2375/containers/json",
		"https://evil.example/metrics",
		"not a url",
	])("refuses %s", async (url) => {
		expect(await isMetricsUrlAllowed(url, "org-1")).toBe(false);
	});
});
