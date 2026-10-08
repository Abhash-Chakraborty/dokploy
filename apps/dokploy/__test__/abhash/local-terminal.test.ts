import { localSshCandidates } from "@dokploy/server/services/abhash/local-terminal";
import { describe, expect, it } from "vitest";

describe("localSshCandidates", () => {
	it("tries root, then the distribution's cloud login user", () => {
		expect(localSshCandidates("Ubuntu 26.04 LTS")).toEqual(["root", "ubuntu"]);
		expect(localSshCandidates("Debian GNU/Linux 13 (trixie)")).toEqual([
			"root",
			"debian",
		]);
		expect(localSshCandidates("Oracle Linux Server 9.4")).toEqual([
			"root",
			"opc",
		]);
		expect(localSshCandidates("Amazon Linux 2023")).toEqual([
			"root",
			"ec2-user",
		]);
	});

	it("tries only root when the distribution is unknown", () => {
		expect(localSshCandidates("Alpine Linux v3.22")).toEqual(["root"]);
		expect(localSshCandidates("")).toEqual(["root"]);
	});

	it("never tries more than two users, to stay clear of fail2ban", () => {
		for (const os of ["Ubuntu", "Debian", "Rocky Linux", "Fedora", "x"]) {
			expect(localSshCandidates(os).length).toBeLessThanOrEqual(2);
		}
	});
});
