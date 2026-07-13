import {
	getDockerHostCandidates,
	getFirstAddressInSubnet,
} from "@/server/utils/docker";
import { describe, expect, it } from "vitest";

describe("local terminal Docker host discovery", () => {
	it("derives the gateway address for a directly attached bridge", () => {
		expect(getFirstAddressInSubnet("172.19.0.0/16")).toBe("172.19.0.1");
		expect(getFirstAddressInSubnet("10.20.30.128/25")).toBe("10.20.30.129");
	});

	it("tries linked bridge gateways before the default overlay gateway", () => {
		const candidates = getDockerHostCandidates(`
default via 172.22.0.1 dev eth0
172.22.0.0/16 dev eth0 proto kernel scope link src 172.22.0.5
172.19.0.0/16 dev eth1 proto kernel scope link src 172.19.0.7
`);

		expect(candidates).toEqual([
			"host.docker.internal",
			"172.19.0.1",
			"172.22.0.1",
			"172.17.0.1",
		]);
	});
});
