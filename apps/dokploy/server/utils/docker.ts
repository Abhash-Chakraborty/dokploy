import net from "node:net";
import { execAsync } from "@dokploy/server";

/** Returns if the current operating system is Windows Subsystem for Linux (WSL). */
export const isWSL = async () => {
	try {
		const { stdout } = await execAsync("uname -r");
		return stdout.includes("microsoft");
	} catch {
		return false;
	}
};

const ipv4ToNumber = (address: string) =>
	address
		.split(".")
		.reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;

const numberToIpv4 = (value: number) =>
	[24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");

export const getFirstAddressInSubnet = (cidr: string) => {
	const [address, rawPrefix] = cidr.split("/");
	const prefix = Number(rawPrefix);
	if (!address || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
		return null;
	}
	const mask = (0xffffffff << (32 - prefix)) >>> 0;
	return numberToIpv4(((ipv4ToNumber(address) & mask) + 1) >>> 0);
};

export const getDockerHostCandidates = (routeOutput: string) => {
	const linkedGateways: string[] = [];
	const defaultGateways: string[] = [];

	for (const line of routeOutput.split(/\r?\n/)) {
		const defaultGateway = line.match(/^default via (\d+(?:\.\d+){3})/);
		if (defaultGateway?.[1]) defaultGateways.push(defaultGateway[1]);

		const linkedSubnet = line.match(
			/^(\d+(?:\.\d+){3}\/\d+)\s+dev\s+\S+\s+.*\bsrc\s+(\d+(?:\.\d+){3})/,
		);
		if (linkedSubnet?.[1]) {
			const gateway = getFirstAddressInSubnet(linkedSubnet[1]);
			if (gateway && gateway !== linkedSubnet[2]) linkedGateways.push(gateway);
		}
	}

	return [
		...new Set([
			"host.docker.internal",
			...linkedGateways.filter((gateway) => !defaultGateways.includes(gateway)),
			...defaultGateways,
			"172.17.0.1",
		]),
	];
};

const canReachTcpPort = (host: string, port: number, timeout = 1_200) =>
	new Promise<boolean>((resolve) => {
		const socket = net.createConnection({ host, port });
		const finish = (reachable: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(reachable);
		};
		socket.setTimeout(timeout);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
	});

/** Finds a host address that actually accepts SSH from the Dokploy container. */
export const getDockerHost = async (
	port = 22,
	additionalCandidates: string[] = [],
): Promise<string> => {
	if (process.env.NODE_ENV !== "production") return "localhost";
	if (process.platform !== "linux" || (await isWSL())) {
		return "host.docker.internal";
	}

	let routeOutput = "";
	try {
		routeOutput = (await execAsync("ip -4 route show")).stdout;
	} catch (error) {
		console.warn("Unable to inspect container routes for local SSH", error);
	}

	const candidates = [
		...new Set([
			...additionalCandidates.filter(Boolean),
			...getDockerHostCandidates(routeOutput),
		]),
	];
	for (const candidate of candidates) {
		if (await canReachTcpPort(candidate, port)) return candidate;
	}

	throw new Error(
		`Unable to reach the host SSH service on port ${port}. Tried: ${candidates.join(", ")}`,
	);
};
