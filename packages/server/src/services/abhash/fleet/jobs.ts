import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { server } from "../../../db/schema";
import { serverSetup } from "../../../setup/server-setup";
import { serverValidate } from "../../../setup/server-validate";
import { resolveTargets } from "../ansible/inventory";
import { PLATFORM_FILES } from "../ansible/playbooks";
import { runPlaybook } from "../ansible/runner";
import { defineJob } from "../jobs/registry";
import { collectFacts } from "../ssh/facts";
import { execPooled } from "../ssh/pool";

const serverIds = z.array(z.string()).min(1).max(200);

const namesOf = async (organizationId: string, ids: string[]) => {
	const rows = await db.query.server.findMany({
		where: and(
			eq(server.organizationId, organizationId),
			inArray(server.serverId, ids),
		),
		columns: { serverId: true, name: true },
	});
	return new Map(rows.map((row) => [row.serverId, row.name]));
};

export type ExecOutcome = {
	server: string;
	exitCode: number | null;
	error?: string;
};

/** Anything that can wipe or restart a machine if the command says so. */
export const fleetExecJob = defineJob({
	type: "fleet.exec",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverIds,
		command: z.string().min(1).max(8_000),
		mode: z.enum(["parallel", "rolling", "serial"]).default("rolling"),
		batchSize: z.number().int().min(1).max(50).default(5),
		stopOnFailure: z.boolean().default(true),
		timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
	}),
	title: (input) =>
		`Run a command on ${input.serverIds.length} server${input.serverIds.length === 1 ? "" : "s"}`,
	destructive: true,
	timeoutMs: 60 * 60_000,
	run: async ({ input, log, progress, signal }) => {
		const names = await namesOf(input.organizationId, input.serverIds);
		const targets = input.serverIds.filter((id) => names.has(id));
		if (targets.length === 0) throw new Error("No servers matched");
		const size =
			input.mode === "parallel"
				? targets.length
				: input.mode === "serial"
					? 1
					: input.batchSize;
		const outcomes: ExecOutcome[] = [];
		let done = 0;

		for (let start = 0; start < targets.length; start += size) {
			signal.throwIfAborted();
			const batch = targets.slice(start, start + size);
			const results = await Promise.all(
				batch.map(async (serverId): Promise<ExecOutcome> => {
					const name = names.get(serverId) as string;
					try {
						const result = await execPooled(serverId, input.command, {
							timeoutMs: input.timeoutMs,
							signal,
							onData: (chunk, stream) => {
								for (const line of chunk.split("\n")) {
									if (line)
										void log(
											`[${name}] ${stream === "stderr" ? "! " : ""}${line}`,
										);
								}
							},
						});
						await log(`[${name}] exit ${result.exitCode}`);
						return { server: name, exitCode: result.exitCode };
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						await log(`[${name}] ERROR ${message}`);
						return { server: name, exitCode: null, error: message };
					}
				}),
			);
			outcomes.push(...results);
			done += batch.length;
			await progress((done / targets.length) * 100);
			if (
				input.stopOnFailure &&
				results.some((result) => result.exitCode !== 0)
			) {
				await log("Stopping: a server failed and stop-on-failure is on");
				break;
			}
		}

		const failed = outcomes.filter((outcome) => outcome.exitCode !== 0);
		if (failed.length) {
			return {
				outcomes,
				failed: failed.length,
				ok: outcomes.length - failed.length,
			};
		}
		return { outcomes, failed: 0, ok: outcomes.length };
	},
});

const platformRun = async (
	organizationId: string,
	ids: string[],
	playbook: string,
	vars: Record<string, unknown>,
	log: (line: string) => Promise<void> | void,
	signal: AbortSignal,
) => {
	const hosts = await resolveTargets(organizationId, {
		serverIds: ids,
		all: false,
	});
	if (hosts.length === 0)
		throw new Error("No servers matched, or none has an SSH key");
	const result = await runPlaybook({
		files: PLATFORM_FILES,
		playbook,
		hosts,
		extraVars: vars,
		checkMode: false,
		become: true,
		signal,
		log,
	});
	if (result.exitCode !== 0) {
		throw new Error(`${playbook} exited with ${result.exitCode}; see the log`);
	}
	return result;
};

export const fleetBootstrapJob = defineJob({
	type: "fleet.bootstrap",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverId: z.string(),
		baseline: z.boolean().default(true),
		hardenSsh: z.boolean().default(true),
		installDocker: z.boolean().default(true),
	}),
	title: () => "Set up a server",
	destructive: true,
	timeoutMs: 60 * 60_000,
	lock: (input) => ({ key: `server:${input.serverId}`, limit: 1 }),
	run: async ({ input, log, progress, signal }) => {
		await log("Connecting and pinning the host key…");
		const facts = await collectFacts(input.serverId, input.organizationId);
		if (facts.health === "offline") {
			throw new Error(`Cannot reach the server: ${facts.error}`);
		}
		await log(`Reached ${facts.facts?.os ?? "the server"}`);
		await progress(20);

		if (input.baseline) {
			await platformRun(
				input.organizationId,
				[input.serverId],
				"baseline.yml",
				{
					dokploy_harden_ssh: input.hardenSsh,
					dokploy_install_packages: true,
					dokploy_tune_kernel: true,
				},
				log,
				signal,
			);
			// The hardening reloads sshd; prove we can still get in.
			const check = await execPooled(input.serverId, "echo ok", {
				timeoutMs: 20_000,
			});
			if (check.stdout.trim() !== "ok") {
				throw new Error("Lost SSH access after hardening");
			}
			await log("Baseline applied, SSH still works");
		}
		await progress(60);

		if (input.installDocker) {
			await log("Installing Docker, Swarm and Traefik (upstream setup)…");
			await serverSetup(input.serverId, (chunk) => {
				for (const line of chunk.split("\n")) if (line) void log(line);
			});
		}
		await progress(90);

		const validation = await serverValidate(input.serverId);
		await collectFacts(input.serverId, input.organizationId);
		return validation;
	},
});

export const fleetPatchJob = defineJob({
	type: "fleet.patch",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverIds,
		batchSize: z.number().int().min(1).max(20).default(1),
		reboot: z.boolean().default(true),
	}),
	title: (input) => `Patch ${input.serverIds.length} server(s)`,
	destructive: true,
	timeoutMs: 3 * 60 * 60_000,
	run: async ({ input, log, signal }) => {
		const result = await platformRun(
			input.organizationId,
			input.serverIds,
			"updates.yml",
			{ dokploy_batch: input.batchSize, dokploy_reboot: input.reboot },
			log,
			signal,
		);
		for (const id of input.serverIds) {
			await collectFacts(id, input.organizationId);
		}
		return result;
	},
});

export const fleetCleanupJob = defineJob({
	type: "fleet.cleanup",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverIds,
		olderThanHours: z.number().int().min(1).max(8760).default(168),
		pruneVolumes: z.boolean().default(false),
	}),
	title: (input) => `Reclaim disk on ${input.serverIds.length} server(s)`,
	// Pruning images is routine; pruning volumes can delete data.
	destructive: (input) => input.pruneVolumes,
	timeoutMs: 60 * 60_000,
	run: async ({ input, log, signal }) => {
		const result = await platformRun(
			input.organizationId,
			input.serverIds,
			"cleanup.yml",
			{
				dokploy_prune_images_hours: input.olderThanHours,
				dokploy_prune_volumes: input.pruneVolumes,
			},
			log,
			signal,
		);
		for (const id of input.serverIds) {
			await collectFacts(id, input.organizationId);
		}
		return result;
	},
});
