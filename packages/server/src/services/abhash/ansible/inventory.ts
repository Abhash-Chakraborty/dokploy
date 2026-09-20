import { and, eq, inArray } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../../db";
import type { AnsibleTargets } from "../../../db/schema";
import { server } from "../../../db/schema";
import { HostKeyMismatchError, verifyHostKey } from "../ssh/pool";

export type InventoryHost = {
	serverId: string;
	name: string;
	address: string;
	port: number;
	user: string;
	privateKey: string;
};

const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "server";

export const resolveTargets = async (
	organizationId: string,
	targets: AnsibleTargets,
): Promise<InventoryHost[]> => {
	const rows = await db.query.server.findMany({
		where: targets.all
			? and(
					eq(server.organizationId, organizationId),
					eq(server.serverStatus, "active"),
				)
			: and(
					eq(server.organizationId, organizationId),
					inArray(
						server.serverId,
						targets.serverIds.length ? targets.serverIds : ["none"],
					),
				),
		with: { sshKey: true },
	});
	const named = new Map<string, number>();
	return rows
		.filter((row) => row.sshKey?.privateKey)
		.map((row) => {
			const base = slug(row.name);
			const seen = named.get(base) ?? 0;
			named.set(base, seen + 1);
			return {
				serverId: row.serverId,
				name: seen === 0 ? base : `${base}-${seen + 1}`,
				address: row.ipAddress,
				port: row.port,
				user: row.username,
				privateKey: row.sshKey?.privateKey as string,
			};
		});
};

export const renderInventory = (hosts: InventoryHost[]) =>
	[
		"[dokploy]",
		...hosts.map(
			(host) =>
				`${host.name} ansible_host=${host.address} ansible_port=${host.port} ansible_user=${host.user} ansible_ssh_private_key_file=keys/${host.name} dokploy_server_id=${host.serverId}`,
		),
		"",
	].join("\n");

/** An SSH public key blob starts with its own algorithm name. */
const algorithmOf = (key: Buffer) => {
	const length = key.readUInt32BE(0);
	return key.subarray(4, 4 + length).toString("ascii");
};

/**
 * Reads a server's host key over a plain SSH handshake, so the run can pin
 * it in known_hosts instead of turning host-key checking off. The key is
 * held to the same pinned fingerprint as every other connection: trusting
 * whatever answers here would hand a run, and its secrets, to anyone able
 * to sit in between.
 */
export const scanHostKey = (host: InventoryHost, timeoutMs = 10_000) =>
	new Promise<string>((resolve, reject) => {
		const conn = new Client();
		let line: string | null = null;
		let mismatch = false;
		const done = (error?: Error) => {
			conn.end();
			if (mismatch) reject(new HostKeyMismatchError(host.serverId));
			else if (error) reject(error);
			else if (line) resolve(line);
			else reject(new Error(`Could not read the host key of ${host.address}`));
		};
		conn
			.on("ready", () => done())
			.on("error", (error) => (line ? done() : done(error as unknown as Error)))
			.connect({
				host: host.address,
				port: host.port,
				username: host.user,
				privateKey: host.privateKey,
				readyTimeout: timeoutMs,
				hostVerifier: (key: Buffer, callback: (ok: boolean) => void) => {
					verifyHostKey(host.serverId, key)
						.then((trusted) => {
							if (trusted) {
								// OpenSSH writes a bare host for port 22 and [host]:port
								// otherwise.
								const entry = `${algorithmOf(key)} ${key.toString("base64")}`;
								line =
									host.port === 22
										? `${host.address} ${entry}`
										: `[${host.address}]:${host.port} ${entry}`;
							} else {
								mismatch = true;
							}
							callback(trusted);
						})
						.catch(() => callback(false));
				},
			});
	});
