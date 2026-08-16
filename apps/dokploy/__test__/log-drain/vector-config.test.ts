import type { LogDrainConfig } from "@dokploy/server/db/schema";
import {
	buildDeployLogDrainCommand,
	buildVectorConfig,
	LOG_DRAIN_CONTAINER,
	redactLogDrainConfig,
} from "@dokploy/server/services/log-drain";
import { describe, expect, it } from "vitest";

const loki: LogDrainConfig = {
	drainType: "loki",
	endpoint: "http://loki:3100",
	labels: { env: "prod" },
};

describe("vector config generation", () => {
	it("excludes the shipper's own container so it can't tail itself", () => {
		const config = buildVectorConfig(loki, { hostname: "node-1" });
		expect(config).toContain(`exclude_containers = ["${LOG_DRAIN_CONTAINER}"]`);
	});

	it("stamps the host onto every event", () => {
		const config = buildVectorConfig(loki, { hostname: "node-1" });
		expect(config).toContain('.host = "node-1"');
	});

	it("accepts out-of-order pushes, which Docker timestamps require", () => {
		const config = buildVectorConfig(loki, { hostname: "node-1" });
		expect(config).toContain('out_of_order_action = "accept"');
	});

	it("merges custom labels with the defaults", () => {
		const config = buildVectorConfig(loki, { hostname: "node-1" });
		expect(config).toContain('"env" = "prod"');
		expect(config).toContain('"service" = "{{ service }}"');
	});

	it("only emits a Loki auth block when credentials are set", () => {
		expect(buildVectorConfig(loki, { hostname: "h" })).not.toContain(
			"[sinks.out.auth]",
		);
		const withAuth = buildVectorConfig(
			{ ...loki, username: "12345", password: "s3cret" },
			{ hostname: "h" },
		);
		expect(withAuth).toContain("[sinks.out.auth]");
		expect(withAuth).toContain('user = "12345"');
	});

	it("carries Datadog tags on the event, since the sink has no tags option", () => {
		const config = buildVectorConfig(
			{
				drainType: "datadog",
				endpoint: "https://http-intake.logs.datadoghq.com",
				apiKey: "dd",
				site: "datadoghq.com",
				tags: "env:prod",
			},
			{ hostname: "h" },
		);
		expect(config).toContain('.ddtags = "env:prod"');
		expect(config).not.toMatch(/^tags = /m);
	});

	it("escapes values into TOML rather than interpolating raw", () => {
		const config = buildVectorConfig(
			{ ...loki, endpoint: 'http://loki:3100/"injected' },
			{ hostname: "h" },
		);
		expect(config).toContain('endpoint = "http://loki:3100/\\"injected"');
	});

	it("emits HTTP headers only when provided", () => {
		const bare = buildVectorConfig(
			{
				drainType: "http",
				endpoint: "https://example.com",
				headers: {},
				encoding: "json",
			},
			{ hostname: "h" },
		);
		expect(bare).not.toContain("[sinks.out.request.headers]");

		const withHeaders = buildVectorConfig(
			{
				drainType: "http",
				endpoint: "https://example.com",
				headers: { Authorization: "Bearer x" },
				encoding: "text",
			},
			{ hostname: "h" },
		);
		expect(withHeaders).toContain("[sinks.out.request.headers]");
		expect(withHeaders).toContain('"Authorization" = "Bearer x"');
		expect(withHeaders).toContain('encoding.codec = "text"');
	});
});

describe("deploy command", () => {
	it("replaces any existing shipper so an edit rolls onto the new config", () => {
		const command = buildDeployLogDrainCommand('data_dir = "/x"');
		expect(command).toContain(`docker rm -f ${LOG_DRAIN_CONTAINER}`);
		expect(command.indexOf("docker rm -f")).toBeLessThan(
			command.indexOf("docker run -d"),
		);
	});

	it("passes the config through base64 rather than shell quoting", () => {
		const command = buildDeployLogDrainCommand("a = 'quoted \"value\"'");
		expect(command).toContain("base64 -d >");
		expect(command).not.toContain("quoted");
	});

	it("mounts the docker socket read-only and caps its own log growth", () => {
		const command = buildDeployLogDrainCommand("x = 1");
		expect(command).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
		expect(command).toContain("--log-opt max-size=10m");
		expect(command).toContain("--restart unless-stopped");
	});
});

describe("redaction", () => {
	it("never returns a Datadog key", () => {
		const redacted = redactLogDrainConfig({
			drainType: "datadog",
			endpoint: "https://x",
			apiKey: "super-secret",
			site: "datadoghq.com",
		});
		expect(JSON.stringify(redacted)).not.toContain("super-secret");
	});

	it("never returns a Loki password but keeps the username", () => {
		const redacted = redactLogDrainConfig({
			...loki,
			username: "12345",
			password: "s3cret",
		});
		expect(JSON.stringify(redacted)).not.toContain("s3cret");
		expect(JSON.stringify(redacted)).toContain("12345");
	});

	it("redacts HTTP header values but keeps their names", () => {
		const redacted = redactLogDrainConfig({
			drainType: "http",
			endpoint: "https://x",
			headers: { Authorization: "Bearer super-secret" },
			encoding: "json",
		});
		expect(JSON.stringify(redacted)).not.toContain("super-secret");
		expect(JSON.stringify(redacted)).toContain("Authorization");
	});
});
