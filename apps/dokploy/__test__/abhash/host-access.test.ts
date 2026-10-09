import {
	createUserScript,
	enableRescueScript,
	parseRescueStatus,
	parseUsers,
	validatePublicKeys,
	validateRescuePort,
	validateUsername,
} from "@dokploy/server/services/abhash/host-access/scripts";
import { describe, expect, it } from "vitest";

const KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDKvrogPefJmmo1S3eo7u8deIr/bOaIIs6raOg2vk0Le me@laptop";

describe("host access scripts", () => {
	it("parses the user listing", () => {
		expect(
			parseUsers(
				"noise\nUSER\talice\t1001\t/bin/bash\t/home/alice\t1\t0\t2\nUSER\tbob\t1002\t/usr/sbin/nologin\t/home/bob\t0\t1\t0\n",
			),
		).toEqual([
			{ name: "alice", uid: 1001, shell: "/bin/bash", home: "/home/alice", admin: true, locked: false, keys: 2 },
			{ name: "bob", uid: 1002, shell: "/usr/sbin/nologin", home: "/home/bob", admin: false, locked: true, keys: 0 },
		]);
	});

	it("parses the rescue status", () => {
		expect(parseRescueStatus("RESCUE\t1\t2299\t1\t22,2299,\tufw\n")).toEqual({
			userExists: true,
			port: 2299,
			managed: true,
			sshPorts: [22, 2299],
			firewall: "ufw",
		});
		expect(parseRescueStatus("")).toMatchObject({ userExists: false, port: null });
	});

	it("rejects user names and keys that could reach the shell", () => {
		expect(() => validateUsername("alice; rm -rf /")).toThrow();
		expect(() => validateUsername("$(id)")).toThrow();
		expect(validateUsername("deploy_bot")).toBe("deploy_bot");
		expect(() => validatePublicKeys("ssh-ed25519 AAAA'; reboot")).toThrow();
		expect(validatePublicKeys(`${KEY}\n\n${KEY}`)).toHaveLength(2);
	});

	it("never interpolates key text into the script", () => {
		const script = createUserScript({ name: "alice", publicKeys: [KEY], sudo: "none" });
		expect(script).not.toContain("me@laptop");
		expect(script).not.toContain("NOPASSWD");
	});

	it("keeps rescue off the normal SSH port", () => {
		expect(() => validateRescuePort(22, [22])).toThrow();
		expect(() => validateRescuePort(80, [22])).toThrow();
		expect(validateRescuePort(2299, [22])).toBe(2299);
		const script = enableRescueScript({ port: 2299, password: "x'y\"z$(id)", sshPorts: [22] });
		expect(script).not.toContain("$(id)");
		expect(script).toContain("sshd -t");
	});
});
