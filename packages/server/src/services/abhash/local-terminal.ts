import { docker } from "../../constants";
import { getSetting, setSetting } from "./flags";

// An empty host means "find it": the panel probes the usual Docker gateway
// addresses. Hosts that keep SSH off the Docker bridges (a VPN-only listener,
// a non-default port) need it set explicitly.
export type LocalSsh = { host?: string; port: number; username: string };

const LOCAL_SSH_SETTING = "terminal.localSsh";

// Stored server-side so every browser opens the host terminal the same way;
// it used to live in localStorage and fell back to root on each new device.
export const getLocalSsh = () =>
	getSetting<LocalSsh | null>(LOCAL_SSH_SETTING, null);

export const saveLocalSsh = (value: LocalSsh, updatedBy?: string) =>
	setSetting(LOCAL_SSH_SETTING, value, updatedBy);

// Cloud images usually refuse root and ship one login user per distribution.
const DEFAULT_USER_BY_OS: [RegExp, string][] = [
	[/ubuntu/i, "ubuntu"],
	[/debian/i, "debian"],
	[/amazon linux/i, "ec2-user"],
	[/oracle/i, "opc"],
	[/rocky/i, "rocky"],
	[/alma/i, "almalinux"],
	[/centos/i, "centos"],
	[/fedora/i, "fedora"],
];

/**
 * Users worth trying for the host terminal, most likely first. Kept to two:
 * each miss is a failed SSH login, and fail2ban on the host would ban the
 * panel's address after a handful of them.
 */
export const localSshCandidates = (operatingSystem: string) => {
	const distroUser = DEFAULT_USER_BY_OS.find(([pattern]) =>
		pattern.test(operatingSystem),
	)?.[1];
	return distroUser ? ["root", distroUser] : ["root"];
};

export const hostOperatingSystem = async () => {
	try {
		const info = await docker.info();
		return String(info.OperatingSystem ?? "");
	} catch {
		return "";
	}
};
