import { and, desc, eq, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashBackupPolicy,
	abhashBackupRepository,
	abhashBackupRun,
	type BackupTargetKind,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "../../../db/schema";
import { execAsync } from "../../../utils/process/execAsync";
import { execPooled } from "../ssh/pool";
import { resolveSecretRefs } from "../vault/secrets";
import { emitEvent } from "../webhooks";
import {
	backupCommand,
	dumpPlan,
	envPrefix,
	forgetSnapshotCommand,
	parseBackupOutput,
	parseSnapshots,
	type ResticEnv,
	resticCommand,
	retentionArgs,
} from "./restic";
import {
	BASE_TAG,
	baseBackupDumpCommand,
	baseBackupFilename,
	currentWalCommand,
	isSegmentName,
} from "./wal";

export type PolicyRow = typeof abhashBackupPolicy.$inferSelect;
export type RepositoryRow = typeof abhashBackupRepository.$inferSelect;

/** Runs a command where the data is: a managed server, or Dokploy's host. */
export const runWhereDataIs = async (
	serverId: string | null,
	command: string,
	options: {
		timeoutMs?: number;
		log?: (line: string) => Promise<void> | void;
	} = {},
) => {
	if (serverId) {
		return execPooled(serverId, command, {
			timeoutMs: options.timeoutMs ?? 60 * 60_000,
			onData: (chunk) => {
				for (const line of chunk.split("\n"))
					if (line) void options.log?.(line);
			},
		});
	}
	try {
		const result = await execAsync(command);
		return { ...result, exitCode: 0 };
	} catch (error) {
		const exec = error as {
			stdout?: string;
			stderr?: string;
			exitCode?: number;
		};
		return {
			stdout: exec.stdout ?? "",
			stderr: exec.stderr ?? String(error),
			exitCode: exec.exitCode ?? 1,
		};
	}
};

const secretScope = (organizationId: string) => ({
	organizationId,
	projectId: organizationId,
});

/** Repository password and backend credentials, resolved from the vault. */
export const repositoryEnv = async (
	repository: RepositoryRow,
): Promise<ResticEnv> => {
	const scope = secretScope(repository.organizationId);
	const password = await resolveSecretRefs(repository.passwordRef, scope);
	if (!password) throw new Error("The repository password is not in the vault");
	const env: ResticEnv = {
		RESTIC_REPOSITORY: repository.repository,
		RESTIC_PASSWORD: password,
	};
	for (const [key, value] of Object.entries(repository.env)) {
		env[key] = (await resolveSecretRefs(value, scope)) ?? value;
	}
	return env;
};

/** A local repository has to be visible inside the restic container. */
export const repoMountOf = (repository: RepositoryRow) => {
	const value = repository.repository;
	if (value.startsWith("/")) return value;
	if (value.startsWith("local:")) return value.slice("local:".length);
	return null;
};

export const findRepository = async (organizationId: string, id: string) => {
	const row = await db.query.abhashBackupRepository.findFirst({
		where: and(
			eq(abhashBackupRepository.id, id),
			eq(abhashBackupRepository.organizationId, organizationId),
		),
	});
	if (!row) throw new Error("Backup repository not found");
	return row;
};

export const findPolicy = async (organizationId: string, id: string) => {
	const policy = await db.query.abhashBackupPolicy.findFirst({
		where: and(
			eq(abhashBackupPolicy.id, id),
			eq(abhashBackupPolicy.organizationId, organizationId),
		),
	});
	if (!policy) throw new Error("Backup policy not found");
	const repository = await findRepository(organizationId, policy.repositoryId);
	return { policy, repository };
};

/** The service a policy points at, with the details its dump command needs. */
export const resolveTarget = async (policy: PolicyRow) => {
	const lookup: Partial<
		Record<
			BackupTargetKind,
			() => Promise<{
				appName: string;
				database?: string;
				username?: string;
				image?: string;
			} | null>
		>
	> = {
		postgres: async () => {
			const row = await db.query.postgres.findFirst({
				where: eq(postgres.postgresId, policy.target),
			});
			return row
				? {
						appName: row.appName,
						database: row.databaseName,
						username: row.databaseUser,
						image: row.dockerImage,
					}
				: null;
		},
		mysql: async () => {
			const row = await db.query.mysql.findFirst({
				where: eq(mysql.mysqlId, policy.target),
			});
			return row
				? {
						appName: row.appName,
						database: row.databaseName,
						image: row.dockerImage,
					}
				: null;
		},
		mariadb: async () => {
			const row = await db.query.mariadb.findFirst({
				where: eq(mariadb.mariadbId, policy.target),
			});
			return row
				? {
						appName: row.appName,
						database: row.databaseName,
						image: row.dockerImage,
					}
				: null;
		},
		mongo: async () => {
			const row = await db.query.mongo.findFirst({
				where: eq(mongo.mongoId, policy.target),
			});
			return row ? { appName: row.appName, image: row.dockerImage } : null;
		},
		redis: async () => {
			const row = await db.query.redis.findFirst({
				where: eq(redis.redisId, policy.target),
			});
			return row ? { appName: row.appName, image: row.dockerImage } : null;
		},
	};
	const resolver = lookup[policy.targetKind];
	if (!resolver) {
		// Volumes, paths and Dokploy itself carry their target inline.
		return { appName: policy.target, path: policy.target };
	}
	const resolved = await resolver();
	if (!resolved) throw new Error("The service this policy backs up is gone");
	return resolved;
};

export const initRepository = async (
	organizationId: string,
	repositoryId: string,
	serverId: string | null,
) => {
	const repository = await findRepository(organizationId, repositoryId);
	const env = await repositoryEnv(repository);
	const mount = repoMountOf(repository);
	const command = `${envPrefix(env)} ${resticCommand(["cat", "config"], { env, repoMount: mount })}`;
	const exists = await runWhereDataIs(serverId, command, {
		timeoutMs: 120_000,
	});
	if (exists.exitCode === 0) return { created: false };
	const init = await runWhereDataIs(
		serverId,
		`${envPrefix(env)} ${resticCommand(["init"], { env, repoMount: mount })}`,
		{ timeoutMs: 300_000 },
	);
	if (init.exitCode !== 0) {
		throw new Error(
			`Could not create the repository: ${init.stderr.slice(0, 300)}`,
		);
	}
	await db
		.update(abhashBackupRepository)
		.set({ initialized: true })
		.where(eq(abhashBackupRepository.id, repository.id));
	return { created: true };
};

export type BackupOutcome = {
	runId: string;
	snapshotId: string;
	bytesAdded: number;
};

/** Runs one backup: dump straight into restic, then apply retention. */
export const runBackup = async (
	organizationId: string,
	policyId: string,
	log: (line: string) => Promise<void> | void,
	redact: (value: string) => void,
): Promise<BackupOutcome> => {
	const { policy, repository } = await findPolicy(organizationId, policyId);
	const env = await repositoryEnv(repository);
	for (const value of Object.values(env)) redact(value);
	const mount = repoMountOf(repository);
	const target = await resolveTarget(policy);
	// WAL can only be replayed onto a physical copy, never onto a dump.
	const physical = policy.walEnabled && policy.targetKind === "postgres";
	const logical = dumpPlan(policy.targetKind, target);
	const plan = physical
		? {
				...logical,
				command: baseBackupDumpCommand({
					appName: target.appName,
					username: (target as { username?: string }).username ?? "postgres",
				}),
				filename: baseBackupFilename(target.appName),
			}
		: logical;

	const [run] = await db
		.insert(abhashBackupRun)
		.values({
			policyId: policy.id,
			status: "running",
			method: physical ? "base" : "logical",
		})
		.returning();
	const runId = run?.id as string;
	const startedAt = Date.now();

	try {
		await initRepository(organizationId, repository.id, policy.serverId);
		if (policy.preHook) {
			await log("Running the pre-backup hook…");
			const hook = await runWhereDataIs(policy.serverId, policy.preHook, {
				log,
			});
			if (hook.exitCode !== 0) throw new Error("The pre-backup hook failed");
		}

		// Numbers a drill can check the restore against.
		let stats: { tables?: number } | undefined;
		if (plan.statsCommand) {
			const counted = await runWhereDataIs(policy.serverId, plan.statsCommand, {
				timeoutMs: 120_000,
			});
			const tables = Number(counted.stdout.trim());
			if (Number.isFinite(tables)) stats = { tables };
		}

		// Read before the copy starts, so it can only be too early, never too
		// late: recovery replays from here, and pruning keeps from here.
		let walStart: string | null = null;
		if (physical) {
			const current = await runWhereDataIs(
				policy.serverId,
				currentWalCommand({
					appName: target.appName,
					username: (target as { username?: string }).username ?? "postgres",
					database: (target as { database?: string }).database ?? "postgres",
				}),
				{ timeoutMs: 60_000 },
			);
			walStart = current.stdout.trim();
			if (current.exitCode !== 0 || !isSegmentName(walStart)) {
				throw new Error("Could not read the current WAL position");
			}
		}

		await log(`Backing up ${policy.name} into ${repository.name}…`);
		const command = backupCommand({
			dump: plan,
			env,
			repoMount: mount,
			tags: [
				"dokploy",
				`policy:${policy.id}`,
				`kind:${policy.targetKind}`,
				`org:${organizationId}`,
				...(physical ? [BASE_TAG] : []),
			],
		});
		const result = await runWhereDataIs(policy.serverId, command, {
			timeoutMs: 6 * 60 * 60_000,
		});
		const summary = parseBackupOutput(result.stdout);
		if (result.exitCode !== 0 || !summary) {
			// A snapshot from a half-finished dump must not survive.
			if (summary?.snapshotId) {
				await runWhereDataIs(
					policy.serverId,
					forgetSnapshotCommand({
						snapshotId: summary.snapshotId,
						env,
						repoMount: mount,
					}),
					{ timeoutMs: 600_000 },
				).catch(() => {});
			}
			throw new Error(
				`The backup failed: ${(result.stderr || result.stdout).slice(-500)}`,
			);
		}
		await log(
			`Snapshot ${summary.snapshotId.slice(0, 8)} · ${(summary.bytesAdded / 1_048_576).toFixed(1)} MB added`,
		);

		if (policy.postHook) {
			await runWhereDataIs(policy.serverId, policy.postHook, { log });
		}

		// Retention, and copies for the 3-2-1 rule.
		const forget = await runWhereDataIs(
			policy.serverId,
			`${envPrefix(env)} ${resticCommand(
				[
					"forget",
					"--prune",
					`--tag policy:${policy.id}`,
					retentionArgs(policy.retention),
				],
				{ env, repoMount: mount },
			)}`,
			{ timeoutMs: 60 * 60_000 },
		);
		if (forget.exitCode !== 0) {
			await log(`Retention did not run cleanly: ${forget.stderr.slice(-300)}`);
		}
		if (forget.exitCode === 0) {
			await forgetExpiredRuns(policy, env, mount, summary.snapshotId);
		}
		if (physical) {
			const { forgetOldWal } = await import("./pitr");
			const trimmed = await forgetOldWal(policy, env, mount);
			if (trimmed.exitCode !== 0) {
				await log(
					`WAL retention did not run cleanly: ${trimmed.stderr.slice(-300)}`,
				);
			}
		}

		for (const copyId of policy.copyToRepositoryIds) {
			const secondary = await findRepository(organizationId, copyId);
			const secondaryEnv = await repositoryEnv(secondary);
			for (const value of Object.values(secondaryEnv)) redact(value);
			await log(`Copying the snapshot to ${secondary.name}…`);
			const copyEnv: ResticEnv = {
				...secondaryEnv,
				RESTIC_FROM_REPOSITORY: env.RESTIC_REPOSITORY as string,
				RESTIC_FROM_PASSWORD: env.RESTIC_PASSWORD as string,
			};
			const copy = await runWhereDataIs(
				policy.serverId,
				`${envPrefix(copyEnv)} ${resticCommand(["copy", summary.snapshotId], {
					env: copyEnv,
					repoMount: repoMountOf(secondary) ?? mount,
				})}`,
				{ timeoutMs: 6 * 60 * 60_000 },
			);
			if (copy.exitCode !== 0) {
				await log(`The copy failed: ${copy.stderr.slice(-300)}`);
			}
		}

		await db
			.update(abhashBackupRun)
			.set({
				status: "succeeded",
				snapshotId: summary.snapshotId,
				walStart,
				bytesAdded: summary.bytesAdded,
				bytesProcessed: summary.bytesProcessed,
				durationMs: Date.now() - startedAt,
				stats,
				finishedAt: new Date(),
			})
			.where(eq(abhashBackupRun.id, runId));
		return {
			runId,
			snapshotId: summary.snapshotId,
			bytesAdded: summary.bytesAdded,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(abhashBackupRun)
			.set({
				status: "failed",
				error: message,
				durationMs: Date.now() - startedAt,
				finishedAt: new Date(),
			})
			.where(eq(abhashBackupRun.id, runId));
		await emitEvent(organizationId, "backup.failed", {
			policyId: policy.id,
			policy: policy.name,
			error: message,
		});
		throw error;
	}
};

/**
 * Retention deletes snapshots from the repository; the rows that recorded
 * them must stop pointing at them, or a recovery could pick a base backup
 * that is no longer there. Nothing is touched unless the listing is
 * trustworthy, which the snapshot just written proves.
 */
const forgetExpiredRuns = async (
	policy: PolicyRow,
	env: ResticEnv,
	mount: string | null,
	justWritten: string,
) => {
	const listed = await runWhereDataIs(
		policy.serverId,
		`${envPrefix(env)} ${resticCommand(
			["snapshots", "--json", `--tag policy:${policy.id}`],
			{ env, repoMount: mount },
		)}`,
		{ timeoutMs: 300_000 },
	);
	const present = parseSnapshots(listed.stdout).map((snapshot) => snapshot.id);
	if (listed.exitCode !== 0 || !present.includes(justWritten)) return;
	await db
		.update(abhashBackupRun)
		.set({ snapshotId: null })
		.where(
			and(
				eq(abhashBackupRun.policyId, policy.id),
				isNotNull(abhashBackupRun.snapshotId),
				notInArray(abhashBackupRun.snapshotId, present),
			),
		);
};

export const listSnapshots = async (
	organizationId: string,
	policyId: string,
) => {
	const { policy, repository } = await findPolicy(organizationId, policyId);
	const env = await repositoryEnv(repository);
	const result = await runWhereDataIs(
		policy.serverId,
		`${envPrefix(env)} ${resticCommand(
			["snapshots", "--json", `--tag policy:${policy.id}`],
			{ env, repoMount: repoMountOf(repository) },
		)}`,
		{ timeoutMs: 120_000 },
	);
	return parseSnapshots(result.stdout);
};

/** Verifies the repository itself, including part of the data. */
export const checkRepository = async (
	organizationId: string,
	repositoryId: string,
	serverId: string | null,
	readDataPercent = 5,
) => {
	const repository = await findRepository(organizationId, repositoryId);
	const env = await repositoryEnv(repository);
	const result = await runWhereDataIs(
		serverId,
		`${envPrefix(env)} ${resticCommand(
			["check", `--read-data-subset=${readDataPercent}%`],
			{ env, repoMount: repoMountOf(repository) },
		)}`,
		{ timeoutMs: 4 * 60 * 60_000 },
	);
	const ok = result.exitCode === 0;
	await db
		.update(abhashBackupRepository)
		.set({ lastCheckAt: new Date(), lastCheckOk: ok })
		.where(eq(abhashBackupRepository.id, repository.id));
	return { ok, output: (result.stdout || result.stderr).slice(-2000) };
};

export const lastRun = (policyId: string) =>
	db.query.abhashBackupRun.findFirst({
		where: eq(abhashBackupRun.policyId, policyId),
		orderBy: [desc(abhashBackupRun.startedAt)],
	});
