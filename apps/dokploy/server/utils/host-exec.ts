import {
	execAsyncRemote,
	findServerById,
	getWebServerSettings,
} from "@dokploy/server";
import { getLocalSsh } from "@dokploy/server/services/abhash/local-terminal";
import { Client, type ConnectConfig } from "ssh2";
import { setupLocalServerSSHKey } from "../wss/utils";
import { getDockerHost } from "./docker";

export type HostResult = { code: number; stdout: string; stderr: string };

// The script travels base64-encoded so no quoting survives into the remote
// shell's parsing of the command line.
const wrap = (script: string) =>
	`printf %s '${Buffer.from(script).toString("base64")}' | base64 -d | sh`;

const sshRun = (
	config: ConnectConfig,
	command: string,
	timeoutMs: number,
): Promise<HostResult> =>
	new Promise((resolve, reject) => {
		const conn = new Client();
		const timer = setTimeout(() => {
			conn.end();
			reject(new Error(`No answer from the server after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		conn
			.once("ready", () => {
				conn.exec(command, (error, stream) => {
					if (error) {
						clearTimeout(timer);
						conn.end();
						reject(error);
						return;
					}
					let stdout = "";
					let stderr = "";
					stream
						.on("close", (code: number) => {
							clearTimeout(timer);
							conn.end();
							resolve({ code: code ?? 0, stdout, stderr });
						})
						.on("data", (data: Buffer) => {
							stdout += data.toString();
						})
						.stderr.on("data", (data: Buffer) => {
							stderr += data.toString();
						});
				});
			})
			.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			})
			.connect({ readyTimeout: 15_000, ...config });
	});

const localConfig = async (): Promise<ConnectConfig> => {
	const saved = await getLocalSsh();
	if (!saved?.username) {
		throw new Error(
			"Dokploy does not know how to log in to this host yet. Open its terminal once, or set Host SSH on the Terminal page.",
		);
	}
	const privateKey = await setupLocalServerSSHKey();
	if (!privateKey) throw new Error("Could not read Dokploy's local SSH key");
	const host =
		saved.host ||
		(await getDockerHost(saved.port, [
			(await getWebServerSettings())?.serverIp || "",
		]));
	return { host, port: saved.port, username: saved.username, privateKey };
};

const remoteConfig = async (serverId: string): Promise<ConnectConfig> => {
	const server = await findServerById(serverId);
	if (!server.sshKey?.privateKey) {
		throw new Error("No SSH key is configured for this server");
	}
	return {
		host: server.ipAddress,
		port: server.port,
		username: server.username,
		privateKey: server.sshKey.privateKey,
	};
};

/** Runs a script on a server ("local" is the Dokploy host) and never throws on a non-zero exit. */
export const runOnHost = async (
	serverId: string,
	script: string,
	options: { timeoutMs?: number; fresh?: boolean } = {},
): Promise<HostResult> => {
	const command = wrap(script);
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (serverId === "local") {
		return sshRun(await localConfig(), command, timeoutMs);
	}
	// A pooled connection outlives an sshd restart, so it cannot prove that
	// new logins still work; a fresh one can.
	if (options.fresh) {
		return sshRun(await remoteConfig(serverId), command, timeoutMs);
	}
	try {
		const { stdout, stderr } = await execAsyncRemote(serverId, command);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failed = error as {
			exitCode?: number;
			stdout?: string;
			stderr?: string;
			message?: string;
		};
		if (typeof failed.exitCode === "number") {
			return {
				code: failed.exitCode,
				stdout: failed.stdout ?? "",
				stderr: failed.stderr ?? "",
			};
		}
		throw error;
	}
};

/** The first "ERROR ..." line a script printed, for a readable message. */
export const scriptError = (result: HostResult) =>
	result.stderr
		.split("\n")
		.find((line) => line.startsWith("ERROR "))
		?.slice(6) ??
	(result.stderr.trim().split("\n").slice(-1)[0] ||
		`exited with code ${result.code}`);
