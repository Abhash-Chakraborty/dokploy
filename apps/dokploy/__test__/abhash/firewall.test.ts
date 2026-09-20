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
		const change = script.indexOf("ufw show added");
		expect(snapshot).toBeGreaterThan(-1);
		expect(change).toBeGreaterThan(-1);
		expect(snapshot).toBeLessThan(change);
	});

	it("arms the rollback before applying, and works without systemd", () => {
		const arm = script.indexOf("rollback.sh");
		expect(arm).toBeLessThan(script.indexOf("ufw show added"));
		expect(script).toContain("systemd-run");
		expect(script).toContain("nohup sh -c 'sleep 120");
	});

	it("replaces only the rules it owns, never the operator's", () => {
		expect(script).not.toContain("ufw --force reset");
		expect(script).toContain(`grep "comment 'dokploy:"`);
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

describe("the lockout guard and rule order", () => {
	const allow = rule({ from: "100.97.0.0/16" });

	it("sees a deny placed before the allow, as the server would", () => {
		const deny = rule({ action: "deny", from: "any", origin: "user:x" });
		expect(wouldLockOut([deny, allow], context)).toMatch(/blocks SSH/);
		// The other way round the allow matches first and the deny is moot.
		expect(wouldLockOut([allow, deny], context)).toBeNull();
	});

	it("knows a wider range covers the address Dokploy comes from", () => {
		const deny = rule({
			action: "deny",
			from: "100.0.0.0/8",
			origin: "user:x",
		});
		expect(wouldLockOut([deny, allow], context)).toMatch(/blocks SSH/);
	});

	it("ignores a deny that is about somewhere else", () => {
		const deny = rule({ action: "deny", from: "203.0.113.0/24" });
		expect(wouldLockOut([deny, allow], context)).toBeNull();
	});

	it("reads port ranges", () => {
		const deny = rule({ action: "deny", port: "1:1024", origin: "user:x" });
		expect(wouldLockOut([deny, allow], context)).toMatch(/blocks SSH/);
	});
});

describe("what may reach the script", () => {
	const hostile = [
		"10.0.0.0/8; rm -rf /",
		"$(reboot)",
		"`id`",
		"1.2.3.4 && curl evil",
		"10.0.0.0/33",
		"not-an-address",
		"",
	];

	it("refuses to render a source that is not an address", () => {
		for (const from of hostile) {
			expect(() => renderUfwRules([rule({ from })])).toThrow(/Refusing/);
			expect(() =>
				renderDockerChain([rule({ chain: "docker", from })]),
			).toThrow(/Refusing/);
		}
	});

	it("refuses a port or a tag that is not one either", () => {
		expect(() => renderUfwRules([rule({ port: "22; reboot" })])).toThrow();
		expect(() =>
			renderUfwRules([rule({ origin: "user:x' ; reboot #" })]),
		).toThrow();
	});

	it("still renders addresses, ranges and IPv6", () => {
		for (const from of ["any", "10.0.0.5", "10.0.0.0/8", "fd00::/8"]) {
			expect(renderUfwRules([rule({ from })])[0]).toContain(`from ${from} `);
		}
	});
});

describe("a published port with several allowed sources", () => {
	const chain = renderDockerChain([
		rule({
			chain: "docker",
			port: "5432",
			from: "203.0.113.7",
			origin: "user:a",
		}),
		rule({
			chain: "docker",
			port: "5432",
			from: "100.97.0.0/16",
			origin: "auto:db",
		}),
	]).split("\n");
	const drop = chain.findIndex((line) => line.includes("default-deny"));

	it("closes the port once, after every source has been let through", () => {
		expect(chain.filter((line) => line.includes("default-deny"))).toHaveLength(
			1,
		);
		expect(drop).toBeGreaterThan(
			chain.findIndex((line) => line.includes("-s 100.97.0.0/16")),
		);
		expect(drop).toBeGreaterThan(
			chain.findIndex((line) => line.includes("-s 203.0.113.7")),
		);
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
