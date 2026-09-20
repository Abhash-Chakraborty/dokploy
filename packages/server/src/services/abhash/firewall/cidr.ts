import { isIP } from "node:net";

/**
 * A source ends up inside a shell script that runs as root, so it is held to
 * exactly one shape: an address, optionally with a prefix length that fits
 * its family. Nothing else gets through, however it got into the database.
 */
export const isCidr = (value: string) => {
	const [address, prefix, ...rest] = value.split("/");
	if (!address || rest.length > 0) return false;
	const family = isIP(address);
	if (family === 0) return false;
	if (prefix === undefined) return true;
	if (!/^\d{1,3}$/.test(prefix)) return false;
	return Number(prefix) <= (family === 4 ? 32 : 128);
};

/** What a rendered rule may name as its source. */
export const assertSource = (from: string) => {
	if (from !== "any" && !isCidr(from)) {
		throw new Error(`Refusing to render a firewall rule from "${from}"`);
	}
	return from;
};

const ipv4ToInt = (address: string) =>
	address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);

/**
 * Whether `address` falls inside `range`. IPv4 only, which is what the
 * lockout guard needs; anything else is only ever equal to itself.
 */
export const cidrContains = (range: string, address: string) => {
	if (range === address) return true;
	const [base, prefix] = range.split("/");
	if (!base || isIP(base) !== 4 || isIP(address.split("/")[0] ?? "") !== 4) {
		return false;
	}
	const bits = prefix === undefined ? 32 : Number(prefix);
	const [inner, innerPrefix] = address.split("/");
	// A range only sits inside another that is at least as wide.
	if (innerPrefix !== undefined && Number(innerPrefix) < bits) return false;
	if (bits === 0) return true;
	const mask = 2 ** 32 - 2 ** (32 - bits);
	const network = (value: string) =>
		Math.floor(ipv4ToInt(value) / 2 ** (32 - bits)) * 2 ** (32 - bits);
	return mask > 0 && network(base) === network(inner as string);
};
