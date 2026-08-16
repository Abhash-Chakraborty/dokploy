import {
	buildDeployCloudflareTunnelCommand,
	buildRemoveCloudflareTunnelCommand,
	CLOUDFLARE_TUNNEL_CONTAINER,
	parseCloudflareTunnelStatus,
} from "@dokploy/server/services/cloudflare-tunnel";
import { describe, expect, it } from "vitest";

describe("cloudflare tunnel deploy command", () => {
	it("replaces an existing connector so a token change takes effect", () => {
		const command = buildDeployCloudflareTunnelCommand("tok");
		expect(command).toContain(`docker rm -f ${CLOUDFLARE_TUNNEL_CONTAINER}`);
		expect(command.indexOf("docker rm -f")).toBeLessThan(
			command.indexOf("docker run -d"),
		);
	});

	it("passes the token through the environment, not the command line", () => {
		const command = buildDeployCloudflareTunnelCommand("s3cret-token");
		expect(command).toContain("-e TUNNEL_TOKEN=s3cret-token");
		expect(command).toContain("tunnel --no-autoupdate run");
		// The bare token must not appear as a positional arg to `tunnel run`,
		// where docker inspect would surface it.
		expect(command).not.toContain("run s3cret-token");
	});

	it("quotes the token so a hostile one can't break out of the command", () => {
		const command = buildDeployCloudflareTunnelCommand(
			"x; touch /tmp/pwned; echo y",
		);
		// The injected command must stay inside quotes, not run as its own step.
		expect(command).not.toMatch(/^touch \/tmp\/pwned$/m);
		expect(command).toContain("TUNNEL_TOKEN='x; touch /tmp/pwned; echo y'");
	});

	it("disables the self-updater, since the image tag is pinned", () => {
		expect(buildDeployCloudflareTunnelCommand("t")).toContain(
			"--no-autoupdate",
		);
	});

	it("caps its own log growth and restarts on reboot", () => {
		const command = buildDeployCloudflareTunnelCommand("t");
		expect(command).toContain("--restart unless-stopped");
		expect(command).toContain("--log-opt max-size=10m");
	});

	it("removes by name so a stale connector can't linger", () => {
		expect(buildRemoveCloudflareTunnelCommand()).toContain(
			CLOUDFLARE_TUNNEL_CONTAINER,
		);
	});
});

describe("cloudflare tunnel status", () => {
	it("reports a missing container plainly", () => {
		const status = parseCloudflareTunnelStatus(
			'{"state":"missing","connections":"0","errors":""}',
		);
		expect(status.running).toBe(false);
		expect(status.detail).toMatch(/isn't running/);
	});

	it("treats running-with-no-connections as a token problem", () => {
		const status = parseCloudflareTunnelStatus(
			'{"state":"running","connections":"0","errors":""}',
		);
		expect(status.running).toBe(true);
		expect(status.connections).toBe(0);
		expect(status.detail).toMatch(/invalid or revoked token/);
	});

	it("surfaces the connector's own error when it has one", () => {
		const status = parseCloudflareTunnelStatus(
			'{"state":"running","connections":"0","errors":"Unauthorized: failed to get tunnel"}',
		);
		expect(status.detail).toContain("Unauthorized");
	});

	it("counts registered edge connections", () => {
		const status = parseCloudflareTunnelStatus(
			'{"state":"running","connections":"4","errors":""}',
		);
		expect(status.running).toBe(true);
		expect(status.connections).toBe(4);
		expect(status.detail).toBe("4 edge connections registered.");
	});

	it("singularises a lone connection", () => {
		expect(
			parseCloudflareTunnelStatus(
				'{"state":"running","connections":"1","errors":""}',
			).detail,
		).toBe("1 edge connection registered.");
	});

	it("degrades rather than throwing on unparseable output", () => {
		const status = parseCloudflareTunnelStatus("not json at all");
		expect(status.running).toBe(false);
		expect(status.detail).toMatch(/Could not read/);
	});

	it("reads the last line, ignoring anything the shell printed first", () => {
		const status = parseCloudflareTunnelStatus(
			'warning: something\n{"state":"running","connections":"2","errors":""}',
		);
		expect(status.connections).toBe(2);
	});
});
