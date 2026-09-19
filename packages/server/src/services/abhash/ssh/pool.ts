import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../../db";
import { abhashServerMeta } from "../../../db/schema";
import { findServerById } from "../../server";

const IDLE_MS = 60_000;
const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 15_000;
// sshd allows 10 sessions per connection by default; stay well under it and
// retry the rest, since other Dokploy features share these connections.
const MAX_CONCURRENT_PER_SERVER = 6;
const CHANNEL_RETRIES = 4;

export class HostKeyMismatchError extends Error {
	constructor(public readonly serverId: string) {
		super(
			"The server's SSH host key changed. Dokploy refuses to connect until an admin accepts the new key.",
		);
		this.name = "HostKeyMismatchError";
	}
}

type Entry = {
	client: Client;
	inFlight: number;
	idleTimer?: NodeJS.Timeout;
	closing: boolean;
};

const shared = globalThis as unknown as {
	__abhashSshPool?: Map<string, Entry>;
	__abhashSshWaiters?: Map<string, (() => void)[]>;
	__abhashSshConnecting?: Map<string, Promise<Entry>>;
};
shared.__abhashSshPool ??= new Map();
shared.__abhashSshWaiters ??= new Map();
shared.__abhashSshConnecting ??= new Map();
const pool = shared.__abhashSshPool;
const waiters = shared.__abhashSshWaiters;
const connecting = shared.__abhashSshConnecting;

export const fingerprint = (key: Buffer) =>
	`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

const meta = (serverId: string) =>
	db.query.abhashServerMeta.findFirst({
		where: eq(abhashServerMeta.serverId, serverId),
	});

/** Trust on first use: the first key seen is remembered and then enforced. */
const verifyHostKey = async (serverId: string, key: Buffer) => {
	const seen = fingerprint(key);
	const row = await meta(serverId);
	if (!row?.hostKey) {
		if (row) {
			await db
				.update(abhashServerMeta)
				.set({ hostKey: seen, hostKeyMismatch: false, updatedAt: new Date() })
				.where(eq(abhashServerMeta.serverId, serverId));
		}
		return true;
	}
	if (row.hostKey === seen) return true;
	await db
		.update(abhashServerMeta)
		.set({ hostKeyMismatch: true, updatedAt: new Date() })
		.where(eq(abhashServerMeta.serverId, serverId));
	return false;
};

const connect = async (serverId: string) => {
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");
	const row = await meta(serverId);
	const address =
		row?.connectVia === "mesh" && row.facts && "meshIp" in row.facts
			? (row.facts as { meshIp?: string }).meshIp || server.ipAddress
			: server.ipAddress;

	return new Promise<Client>((resolve, reject) => {
		const client = new Client();
		let mismatch = false;
		client
			.once("ready", () => resolve(client))
			.once("error", (error) =>
				reject(mismatch ? new HostKeyMismatchError(serverId) : error),
			)
			.connect({
				host: address,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				readyTimeout: READY_TIMEOUT_MS,
				keepaliveInterval: KEEPALIVE_MS,
				hostVerifier: (key: Buffer, callback?: (ok: boolean) => void) => {
					// ssh2 accepts a callback for async verification.
					void verifyHostKey(serverId, key).then((ok) => {
						mismatch = !ok;
						callback?.(ok);
					});
					return undefined as unknown as boolean;
				},
			});
	});
};

const release = (serverId: string, entry: Entry) => {
	entry.inFlight--;
	const queue = waiters.get(serverId);
	const next = queue?.shift();
	if (next) {
		next();
		return;
	}
	if (entry.inFlight === 0) {
		entry.idleTimer = setTimeout(() => {
			if (entry.inFlight === 0 && !entry.closing) {
				entry.closing = true;
				pool.delete(serverId);
				entry.client.end();
			}
		}, IDLE_MS);
		entry.idleTimer.unref();
	}
};

const openEntry = async (serverId: string) => {
	const client = await connect(serverId);
	const entry: Entry = { client, inFlight: 0, closing: false };
	client.on("close", () => {
		entry.closing = true;
		if (pool.get(serverId) === entry) pool.delete(serverId);
	});
	pool.set(serverId, entry);
	return entry;
};

const acquire = async (serverId: string): Promise<Entry> => {
	let entry = pool.get(serverId);
	if (entry?.closing) entry = undefined;
	if (!entry) {
		// A burst of calls for the same server must share one handshake,
		// or sshd refuses the extra connections.
		let pending = connecting.get(serverId);
		if (!pending) {
			pending = openEntry(serverId).finally(() => connecting.delete(serverId));
			connecting.set(serverId, pending);
		}
		entry = await pending;
	}
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	if (entry.inFlight >= MAX_CONCURRENT_PER_SERVER) {
		await new Promise<void>((resolve) => {
			const queue = waiters.get(serverId) ?? [];
			queue.push(resolve);
			waiters.set(serverId, queue);
		});
	}
	entry.inFlight++;
	return entry;
};

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export interface PooledExecOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onData?: (chunk: string, stream: "stdout" | "stderr") => void;
}

/**
 * Runs one command over a pooled connection. Unlike the upstream helper this
 * reuses connections, verifies the host key, applies a timeout and can be
 * cancelled, and it returns the exit code instead of throwing on failure.
 */
const isChannelBusy = (error: unknown) =>
	error instanceof Error && /channel open failure/i.test(error.message);

export const execPooled = async (
	serverId: string,
	command: string,
	options: PooledExecOptions = {},
): Promise<ExecResult> => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await execOnce(serverId, command, options);
		} catch (error) {
			if (!isChannelBusy(error) || attempt >= CHANNEL_RETRIES) throw error;
			await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
		}
	}
};

const execOnce = async (
	serverId: string,
	command: string,
	options: PooledExecOptions,
): Promise<ExecResult> => {
	const entry = await acquire(serverId);
	try {
		return await new Promise<ExecResult>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const timer = setTimeout(
				() =>
					finish(() =>
						reject(
							new Error(
								`Timed out after ${(options.timeoutMs ?? 120_000) / 1000}s: ${command.slice(0, 80)}`,
							),
						),
					),
				options.timeoutMs ?? 120_000,
			);
			timer.unref();
			const onAbort = () => finish(() => reject(new Error("Cancelled")));
			options.signal?.addEventListener("abort", onAbort, { once: true });

			entry.client.exec(command, (error, stream) => {
				if (error) {
					finish(() => reject(error));
					return;
				}
				stream
					.on("close", (code: number) =>
						finish(() => resolve({ stdout, stderr, exitCode: code ?? 0 })),
					)
					.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
						options.onData?.(chunk.toString(), "stdout");
					})
					.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
						options.onData?.(chunk.toString(), "stderr");
					});
			});
		});
	} finally {
		release(serverId, entry);
	}
};

export const closeConnection = (serverId: string) => {
	const entry = pool.get(serverId);
	if (!entry) return;
	entry.closing = true;
	pool.delete(serverId);
	entry.client.end();
};

export const closeAllConnections = () => {
	for (const serverId of [...pool.keys()]) closeConnection(serverId);
};

export const poolSize = () => pool.size;
