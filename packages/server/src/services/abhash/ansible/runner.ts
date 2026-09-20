import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { type InventoryHost, renderInventory, scanHostKey } from "./inventory";

export const RUNNER_IMAGE = () =>
	process.env.ABHASH_ANSIBLE_RUNNER_IMAGE ||
	"ghcr.io/abhash-chakraborty/dokploy-ansible-runner:2.19.3";

const HELPER_IMAGE = "alpine:3.20";
const RUNNER_UID = 10001;

export type HostRecap = {
	host: string;
	ok: number;
	changed: number;
	unreachable: number;
	failed: number;
};

export type RunResult = {
	exitCode: number;
	recap: HostRecap[];
	changed: boolean;
};

export interface RunOptions {
	files: Record<string, string>;
	playbook: string;
	hosts: InventoryHost[];
	extraVars?: Record<string, unknown>;
	checkMode?: boolean;
	become?: boolean;
	forks?: number;
	limit?: string | null;
	tags?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
	log: (line: string) => Promise<void> | void;
}

const docker = (args: string[], options: { input?: Buffer } = {}) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = spawn("docker", args, { stdio: "pipe" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		if (options.input) child.stdin.end(options.input);
		else child.stdin.end();
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});

/** `ok=2 changed=1 unreachable=0 failed=0` per host, at the end of a run. */
export const parseRecap = (output: string): HostRecap[] => {
	const recap: HostRecap[] = [];
	const lines = output.split("\n");
	const start = lines.findIndex((line) => line.includes("PLAY RECAP"));
	if (start === -1) return recap;
	for (const line of lines.slice(start + 1)) {
		const match = line.match(
			/^(\S+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)/,
		);
		if (!match) continue;
		recap.push({
			host: match[1] as string,
			ok: Number(match[2]),
			changed: Number(match[3]),
			unreachable: Number(match[4]),
			failed: Number(match[5]),
		});
	}
	return recap;
};

const writeWorkDir = async (dir: string, options: RunOptions) => {
	await fs.mkdir(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
	for (const [file, contents] of Object.entries(options.files)) {
		if (file.includes("..") || path.isAbsolute(file)) {
			throw new Error(`Refusing to write outside the run directory: ${file}`);
		}
		const target = path.join(dir, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, contents, { mode: 0o600 });
	}
	await fs.writeFile(
		path.join(dir, "inventory.ini"),
		renderInventory(options.hosts),
		{ mode: 0o600 },
	);
	for (const host of options.hosts) {
		await fs.writeFile(path.join(dir, "keys", host.name), host.privateKey, {
			mode: 0o600,
		});
	}
	await fs.writeFile(
		path.join(dir, "extra_vars.json"),
		JSON.stringify(options.extraVars ?? {}),
		{ mode: 0o600 },
	);
};

/**
 * Runs a playbook in a throwaway container: Dokploy itself never carries
 * Ansible. The work directory is copied into a volume rather than mounted,
 * so it works the same whether the Docker daemon is local, remote or the
 * sandbox's. Host keys are pinned before the run, so host-key checking
 * stays on.
 */
export const runPlaybook = async (options: RunOptions): Promise<RunResult> => {
	const runId = nanoid(10).toLowerCase();
	const volume = `abhash-ansible-${runId}`;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abhash-ansible-"));
	const helper = `abhash-ansible-load-${runId}`;
	let output = "";

	try {
		await writeWorkDir(dir, options);

		await options.log("Reading host keys…");
		const knownHosts: string[] = [];
		for (const host of options.hosts) {
			knownHosts.push(await scanHostKey(host));
		}
		await fs.writeFile(
			path.join(dir, "known_hosts"),
			`${knownHosts.join("\n")}\n`,
			{
				mode: 0o600,
			},
		);

		const created = await docker(["volume", "create", volume]);
		if (created.code !== 0) throw new Error(created.stderr.trim());
		const started = await docker([
			"run",
			"-d",
			"--name",
			helper,
			"-v",
			`${volume}:/work`,
			HELPER_IMAGE,
			"sleep",
			"120",
		]);
		if (started.code !== 0) throw new Error(started.stderr.trim());
		const copied = await docker(["cp", `${dir}/.`, `${helper}:/work`]);
		if (copied.code !== 0) throw new Error(copied.stderr.trim());
		// The runner is unprivileged, and SSH refuses a key it cannot read.
		const owned = await docker([
			"exec",
			helper,
			"chown",
			"-R",
			`${RUNNER_UID}:${RUNNER_UID}`,
			"/work",
		]);
		if (owned.code !== 0) throw new Error(owned.stderr.trim());
		await docker(["rm", "-f", helper]);

		const args = [
			"run",
			"--rm",
			"--network",
			"host",
			"-v",
			`${volume}:/work`,
			"-w",
			"/work",
			"--read-only",
			"--tmpfs",
			"/tmp",
			"--memory",
			"512m",
			"--cpus",
			"1",
			"-e",
			"ANSIBLE_HOST_KEY_CHECKING=True",
			"-e",
			"ANSIBLE_SSH_ARGS=-o UserKnownHostsFile=/work/known_hosts -o ControlMaster=auto -o ControlPersist=60s",
			"-e",
			"HOME=/tmp",
			RUNNER_IMAGE(),
			"-i",
			"inventory.ini",
			options.playbook,
			"-e",
			"@extra_vars.json",
			"-f",
			String(options.forks ?? 5),
		];
		if (options.checkMode) args.push("--check", "--diff");
		if (options.become) args.push("--become");
		if (options.limit) args.push("--limit", options.limit);
		if (options.tags?.length) args.push("--tags", options.tags.join(","));

		await options.log(
			`Running ${options.playbook}${options.checkMode ? " (check mode)" : ""} on ${options.hosts.length} server(s)`,
		);

		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn("docker", args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const timeout = setTimeout(
				() => child.kill("SIGKILL"),
				options.timeoutMs ?? 30 * 60_000,
			);
			const onAbort = () => child.kill("SIGKILL");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			let buffer = "";
			const pump = (chunk: Buffer) => {
				output += chunk.toString();
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) void options.log(line);
			};
			child.stdout.on("data", pump);
			child.stderr.on("data", pump);
			child.on("close", (code) => {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
				if (buffer) void options.log(buffer);
				resolve(code ?? 1);
			});
		});

		const recap = parseRecap(output);
		return {
			exitCode,
			recap,
			changed: recap.some((host) => host.changed > 0),
		};
	} finally {
		await docker(["rm", "-f", helper]).catch(() => {});
		await docker(["volume", "rm", "-f", volume]).catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	}
};
