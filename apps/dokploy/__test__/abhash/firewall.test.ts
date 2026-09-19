import type { CompiledRule } from "@dokploy/server/services/abhash/firewall/compile";
import { wouldLockOut } from "@dokploy/server/services/abhash/firewall/compile";
import {
	applyScript,
	MANAGED_CHAIN,
	render,
	renderDockerChain,
	renderUfwRules,
} from "@dokploy/server/services/abhash/firewall/render";
import { describe, expect, it } from "vitest";

const rule = (overrides: Partial<CompiledRule> = {}): CompiledRule => ({
	chain: "input",
	action: "allow",
	protocol: "tcp",
	port: "22",
	from: "any",
	comment: "SSH",
	origin: "auto:ssh",
	...overrides,
});

const context = {
	serverId: "s1",
	organizationId: "o1",
	sshPort: 22,
	meshSubnet: "100.97.0.0/16",
	controlAddress: "100.97.0.0/16",
};

describe("rendering ufw rules", () => {
	it("tags every rule so Dokploy can tell its own apart", () => {
		expect(renderUfwRules([rule({ from: "100.97.0.0/16" })])).toEqual([
			"ufw allow from 100.97.0.0/16 to any port 22 proto tcp comment 'dokploy:auto:ssh'",
		]);
	});

	it("rate-limits with ufw's own limit action", () => {
		expect(renderUfwRules([rule({ action: "limit" })])[0]).toContain(
			"ufw limit from any",
		);
	});

	it("leaves published container ports out of ufw", () => {
		expect(renderUfwRules([rule({ chain: "docker", port: "5432" })])).toEqual(
			[],
		);
	});
});

describe("rendering the Docker chain", () => {
	const block = renderDockerChain([
		rule({ chain: "docker", port: "5432", from: "100.97.0.0/16" }),
	]);

	it("matches the port the client asked for, before Docker's DNAT", () => {
		expect(block).toContain("--ctorigdstport 5432");
	});

	it("allows the listed source and drops everything else to that port", () => {
		expect(block).toContain("-s 100.97.0.0/16");
		expect(block).toMatch(/-j RETURN/);
		expect(block).toContain("default-deny");
	});

	it("hooks the chain into DOCKER-USER", () => {
		expect(block).toContain(`-I DOCKER-USER -j ${MANAGED_CHAIN}`);
	});

	it("handles a port range", () => {
		expect(
			renderDockerChain([rule({ chain: "docker", port: "8000:8010" })]),
		).toContain("--ctorigdstport 8000:8010");
	});
});

describe("the apply script", () => {
	const script = applyScript(render([rule()]), {
		rollbackSeconds: 120,
		defaultIncoming: "deny",
	});

	it("snapshots before it changes anything", () => {
		const snapshot = script.indexOf("iptables-save");
		const change = script.indexOf("ufw --force reset");
		expect(snapshot).toBeGreaterThan(-1);
		expect(snapshot).toBeLessThan(change);
	});

	it("arms the rollback before applying, and works without systemd", () => {
		const arm = script.indexOf("rollback.sh");
		expect(arm).toBeLessThan(script.indexOf("ufw --force reset"));
		expect(script).toContain("systemd-run");
		expect(script).toContain("nohup sh -c 'sleep 120");
	});

	it("defaults incoming traffic to deny", () => {
		expect(script).toContain("ufw default deny incoming");
	});
});

describe("the lockout guard", () => {
	it("refuses a ruleset with no SSH rule", () => {
		expect(wouldLockOut([rule({ port: "80" })], context)).toMatch(/lock/i);
	});

	it("refuses an SSH rule that does not cover Dokploy's own path", () => {
		expect(wouldLockOut([rule({ from: "10.0.0.0/8" })], context)).toMatch(
			/does not|No SSH rule covers/i,
		);
	});

	it("accepts SSH from the mesh when that is how Dokploy connects", () => {
		expect(wouldLockOut([rule({ from: "100.97.0.0/16" })], context)).toBeNull();
	});

	it("accepts SSH from anywhere", () => {
		expect(wouldLockOut([rule({ from: "any" })], context)).toBeNull();
	});

	it("does not count a deny rule as access", () => {
		expect(wouldLockOut([rule({ action: "deny" })], context)).toMatch(/lock/i);
	});
});

describe("the hash", () => {
	it("changes when the rules change and is stable when they do not", () => {
		const a = render([rule()]);
		const b = render([rule()]);
		const c = render([rule({ port: "2222" })]);
		expect(a.hash).toBe(b.hash);
		expect(a.hash).not.toBe(c.hash);
	});
});
