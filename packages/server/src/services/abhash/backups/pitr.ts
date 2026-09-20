import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../../db";
import {
	abhashBackupPolicy,
	abhashBackupRun,
	type DrillCheck,
	mounts,
	type WalStatus,
} from "../../../db/schema";
import { emitEvent } from "../webhooks";
import {
	envPrefix,
	parseBackupOutput,
	parseSnapshots,
	type ResticEnv,
	resticCommand,
} from "./restic";
import {
	findPolicy,
	type PolicyRow,
	repoMountOf,
	repositoryEnv,
	resolveTarget,
	runWhereDataIs,
} from "./service";
import {
	archiverStatusCommand,
	baseBackupFilename,
	dataSubpathOf,
	disableArchivingCommand,
	enableArchivingCommand,
	findSegmentGap,
	listArchiveCommand,
	parseArchiverStatus,
	prepareArchiveCommand,
	prunableArchiveFiles,
	pruneArchiveCommand,
	recoverySettings,
	switchWalCommand,
	WAL_MOUNT_PATH,
	WAL_TAG,
	walVolumeName,
} from "./wal";

type Log = (line: string) => Promise<void> | void;

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Forces a segment switch on a quiet database, which bounds what is lost. */
export const ARCHIVE_TIMEOUT_SECONDS = 60;
/**
 * Segments are only pruned once a ship has run this long after the base
 * backup that makes them unnecessary. Until then a snapshot holding both
 * the old segments and the new base is guaranteed to exist, so every moment
 * before that base stays recoverable.
 */
const PRUNE_GRACE_MS = 120_000;
/** A recovery target this close to a snapshot is served by the next one. */
const SNAPSHOT_MARGIN_MS = 90_000;
const PENDING_SEGMENTS_ALARM = 3;

/** WAL snapshots carry their own tag so base-backup retention skips them. */
export const walPolicyTag = (policyId: string) => `walpolicy:${policyId}`;

export type WalTarget = {
	appName: string;
	database: string;
	username: string;
	image: string;
};

export const walTarget = async (policy: PolicyRow): Promise<WalTarget> => {
	if (policy.targetKind !== "postgres") {
		throw new Error("WAL archiving is for Postgres policies");
	}
	const target = (await resolveTarget(policy)) as Partial<WalTarget> & {
		appName: string;
	};
	return {
		appName: target.appName,
		database: target.database ?? "postgres",
		username: target.username ?? "postgres",
		image: target.image ?? "postgres:18",
	};
};

export const readArchiverStatus = async (
	policy: PolicyRow,
	target: WalTarget,
) => {
	const result = await runWhereDataIs(
		policy.serverId,
		archiverStatusCommand(target),
		{ timeoutMs: 60_000 },
	);
	return result.exitCode === 0 ? parseArchiverStatus(result.stdout) : null;
};

/**
 * Writes the archive settings and the script. `archive_mode` only takes
 * effect after a restart, which is the caller's to arrange: in production
 * that is a redeploy, which also attaches the WAL volume.
 */
export const configureArchiving = async (policy: PolicyRow) => {
	const target = await walTarget(policy);
	const result = await runWhereDataIs(
		policy.serverId,
		enableArchivingCommand(target, ARCHIVE_TIMEOUT_SECONDS),
		{ timeoutMs: 120_000 },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not configure archiving: ${(result.stderr || result.stdout).slice(-300)}`,
		);
	}
	const status = await readArchiverStatus(policy, target);
	return { restartNeeded: status?.archiveMode !== "on" };
};

export const prepareArchive = async (policy: PolicyRow) => {
	const target = await walTarget(policy);
	const result = await runWhereDataIs(
		policy.serverId,
		prepareArchiveCommand(target.appName),
		{ timeoutMs: 120_000 },
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not prepare the WAL volume: ${(result.stderr || result.stdout).slice(-300)}`,
		);
	}
};

/**
 * Turns archiving on for a deployed Postgres service. The settings go in
 * first, so the single redeploy that attaches the volume also applies them.
 */
export const enableWal = async (
	organizationId: string,
	policyId: string,
	log: Log,
) => {
	const { policy } = await findPolicy(organizationId, policyId);
	const target = await walTarget(policy);

	await log("Writing the archive settings…");
	const { restartNeeded } = await configureArchiving(policy);

	const existing = await db.query.mounts.findFirst({
		where: and(
			eq(mounts.postgresId, policy.target),
			eq(mounts.mountPath, WAL_MOUNT_PATH),
		),
	});
	if (!existing) {
		const { createMount } = await import("../../mount");
		await createMount({
			type: "volume",
			volumeName: walVolumeName(target.appName),
			mountPath: WAL_MOUNT_PATH,
			serviceType: "postgres",
			serviceId: policy.target,
		} as never);
	}
	if (!existing || restartNeeded) {
		await log("Redeploying the database once to attach the WAL volume…");
		const { deployPostgres } = await import("../../postgres");
		await deployPostgres(policy.target, (line) => void log(String(line)));
		await waitForDatabase(policy, target);
	}

	await prepareArchive(policy);
	await db
		.update(abhashBackupPolicy)
		.set({ walEnabled: true })
		.where(eq(abhashBackupPolicy.id, policy.id));
	await log("Archiving is on. A base backup comes next.");
};

const waitForDatabase = async (policy: PolicyRow, target: WalTarget) => {
	for (let attempt = 0; attempt < 90; attempt++) {
		if (await readArchiverStatus(policy, target)) return;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	throw new Error("The database did not come back after the redeploy");
};

export const disableWal = async (organizationId: string, policyId: string) => {
	const { policy } = await findPolicy(organizationId, policyId);
	const target = await walTarget(policy);
	// Best effort: the policy is switched off even if the database is down,
	// or nothing could ever stop a ship job that keeps failing.
	await runWhereDataIs(policy.serverId, disableArchivingCommand(target), {
		timeoutMs: 120_000,
	}).catch(() => null);
	await db
		.update(abhashBackupPolicy)
		.set({ walEnabled: false, walStatus: null })
		.where(eq(abhashBackupPolicy.id, policy.id));
};

const latestBase = (policyId: string, finishedBefore?: Date) =>
	db.query.abhashBackupRun.findFirst({
		where: and(
			eq(abhashBackupRun.policyId, policyId),
			eq(abhashBackupRun.status, "succeeded"),
			eq(abhashBackupRun.method, "base"),
			// Retention clears this once the snapshot has left the repository.
			isNotNull(abhashBackupRun.snapshotId),
			...(finishedBefore
				? [lte(abhashBackupRun.finishedAt, finishedBefore)]
				: []),
		),
		orderBy: [desc(abhashBackupRun.finishedAt)],
	});

export type ShipOutcome = {
	snapshotId: string;
	bytesAdded: number;
	pruned: number;
	problem: string | null;
};

/**
 * Snapshots the WAL volume into the repository. It reads the volume, not
 * the database, so it still works when Postgres is down: the moment the
 * latest segments matter most.
 */
export const shipWal = async (
	organizationId: string,
	policyId: string,
	log: Log,
	redact: (value: string) => void,
	options: { switchSegment?: boolean } = {},
): Promise<ShipOutcome> => {
	const { policy, repository } = await findPolicy(organizationId, policyId);
	if (!policy.walEnabled)
		throw new Error("WAL archiving is off for this policy");
	const target = await walTarget(policy);
	const env = await repositoryEnv(repository);
	for (const value of Object.values(env)) redact(value);

	if (options.switchSegment) {
		await runWhereDataIs(policy.serverId, switchWalCommand(target), {
			timeoutMs: 60_000,
		}).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}

	const archiver = await readArchiverStatus(policy, target);
	const shipped = await runWhereDataIs(
		policy.serverId,
		`${envPrefix(env)} ${resticCommand(
			[
				"backup",
				"--json",
				// A fixed host lets restic find the previous snapshot and skip
				// every segment it has already stored.
				"--host dokploy",
				// Retention holds an exclusive lock while it prunes; wait for it
				// rather than report a ship that merely arrived at a bad time.
				"--retry-lock 15m",
				`--tag ${WAL_TAG}`,
				`--tag ${quote(walPolicyTag(policy.id))}`,
				`${WAL_MOUNT_PATH}/wal`,
			],
			{
				env,
				repoMount: repoMountOf(repository),
				volumes: [`${walVolumeName(target.appName)}:${WAL_MOUNT_PATH}:ro`],
			},
		)}`,
		{ timeoutMs: 60 * 60_000 },
	);
	const summary = parseBackupOutput(shipped.stdout);
	if (shipped.exitCode !== 0 || !summary?.snapshotId) {
		const message = `Shipping WAL failed: ${(shipped.stderr || shipped.stdout).slice(-300)}`;
		await recordStatus(policy, archiver, null, message);
		throw new Error(message);
	}

	const pruned = await pruneLocalArchive(policy, target).catch(
		async (error) => {
			await log(`Pruning the local archive failed: ${String(error)}`);
			return {
				removed: 0,
				prunedBefore: policy.walStatus?.prunedBefore ?? null,
			};
		},
	);

	const previousFailures = policy.walStatus?.failedCount ?? 0;
	const problem = !archiver
		? "The database did not answer; WAL already archived was still shipped"
		: archiver.archiveMode !== "on"
			? "Archiving is configured but the database has not restarted yet"
			: archiver.failedCount > previousFailures
				? `Postgres failed to archive ${archiver.lastFailedWal ?? "a segment"}`
				: archiver.pendingSegments >= PENDING_SEGMENTS_ALARM
					? `${archiver.pendingSegments} segments are waiting to be archived`
					: null;
	await recordStatus(
		policy,
		archiver,
		summary.snapshotId,
		problem,
		pruned.prunedBefore,
	);
	return {
		snapshotId: summary.snapshotId,
		bytesAdded: summary.bytesAdded,
		pruned: pruned.removed,
		problem,
	};
};

const recordStatus = async (
	policy: PolicyRow,
	archiver: Awaited<ReturnType<typeof readArchiverStatus>>,
	snapshotId: string | null,
	problem: string | null,
	prunedBefore: string | null = policy.walStatus?.prunedBefore ?? null,
) => {
	const previous = policy.walStatus;
	const now = new Date().toISOString();
	const status: WalStatus = {
		checkedAt: now,
		archiveMode: archiver?.archiveMode ?? null,
		lastArchivedWal:
			archiver?.lastArchivedWal ?? previous?.lastArchivedWal ?? null,
		lastArchivedAt:
			archiver?.lastArchivedAt ?? previous?.lastArchivedAt ?? null,
		failedCount: archiver?.failedCount ?? previous?.failedCount ?? 0,
		lagSeconds: archiver?.lagSeconds ?? null,
		pendingSegments: archiver?.pendingSegments ?? 0,
		lastShippedAt: snapshotId ? now : (previous?.lastShippedAt ?? null),
		lastShipSnapshotId: snapshotId ?? previous?.lastShipSnapshotId ?? null,
		prunedBefore,
		problem,
	};
	await db
		.update(abhashBackupPolicy)
		.set({ walStatus: status })
		.where(eq(abhashBackupPolicy.id, policy.id));
	// Once per incident, not once per ship.
	if (problem && !previous?.problem) {
		await emitEvent(policy.organizationId, "wal.lagging", {
			policyId: policy.id,
			policy: policy.name,
			problem,
		});
	}
};

const pruneLocalArchive = async (
	policy: PolicyRow,
	target: WalTarget,
): Promise<{ removed: number; prunedBefore: string | null }> => {
	const already = policy.walStatus?.prunedBefore ?? null;
	const unchanged = { removed: 0, prunedBefore: already };
	const base = await latestBase(policy.id);
	const previousShip = policy.walStatus?.lastShippedAt;
	if (!base?.walStart || !base.finishedAt || !previousShip) return unchanged;
	// Nothing new can be prunable until there is a newer base backup.
	if (base.walStart === already) return unchanged;
	if (
		new Date(previousShip).getTime() <
		base.finishedAt.getTime() + PRUNE_GRACE_MS
	) {
		return unchanged;
	}
	const listed = await runWhereDataIs(
		policy.serverId,
		listArchiveCommand(target.appName),
		{ timeoutMs: 120_000 },
	);
	if (listed.exitCode !== 0) return unchanged;
	const files = prunableArchiveFiles(
		listed.stdout.split("\n").map((line) => line.trim()),
		base.walStart,
	);
	const command = pruneArchiveCommand(target.appName, files);
	if (!command) return { removed: 0, prunedBefore: base.walStart };
	const removed = await runWhereDataIs(policy.serverId, command, {
		timeoutMs: 300_000,
	});
	return removed.exitCode === 0
		? { removed: files.length, prunedBefore: base.walStart }
		: unchanged;
};

/** Drops WAL snapshots older than the window a point in time can be in. */
export const forgetOldWal = async (
	policy: PolicyRow,
	env: ResticEnv,
	repoMount: string | null,
) =>
	runWhereDataIs(
		policy.serverId,
		`${envPrefix(env)} ${resticCommand(
			[
				"forget",
				"--prune",
				`--tag ${quote(`${WAL_TAG},${walPolicyTag(policy.id)}`)}`,
				`--keep-within ${policy.walRetentionDays}d`,
			],
			{ env, repoMount },
		)}`,
		{ timeoutMs: 60 * 60_000 },
	);

/** The span a recovery target can be picked from. */
export const recoveryWindow = async (
	organizationId: string,
	policyId: string,
) => {
	const { policy } = await findPolicy(organizationId, policyId);
	const horizon = new Date(Date.now() - policy.walRetentionDays * 86_400_000);
	const bases = await db.query.abhashBackupRun.findMany({
		where: and(
			eq(abhashBackupRun.policyId, policy.id),
			eq(abhashBackupRun.status, "succeeded"),
			eq(abhashBackupRun.method, "base"),
			isNotNull(abhashBackupRun.snapshotId),
		),
		orderBy: [desc(abhashBackupRun.finishedAt)],
		columns: { finishedAt: true },
	});
	const usable = bases
		.map((base) => base.finishedAt)
		.filter((value): value is Date => !!value && value >= horizon);
	const earliest = usable.at(-1) ?? null;
	const latest = policy.walStatus?.lastArchivedAt
		? new Date(policy.walStatus.lastArchivedAt)
		: null;
	return {
		earliest,
		latest: earliest && latest && latest > earliest ? latest : earliest,
	};
};

export type RecoveryOptions = {
	/** ISO timestamp, or null for "as far as the WAL goes". */
	targetTime: string | null;
	/** Keep the recovered data volume once it has been verified. */
	keepVolume: boolean;
	/** Where to run; defaults to the server the database lives on. */
	serverId?: string | null;
	/** Runs against the recovered copy before it is shut down. */
	verify?: (
		query: (sql: string) => Promise<{ ok: boolean; value: string }>,
	) => Promise<void>;
	timeoutMinutes?: number;
};

export type RecoveryOutcome = {
	volume: string | null;
	baseSnapshotId: string;
	walSnapshotId: string;
	recoveredTo: string;
	tables: number;
	seconds: number;
	checks: DrillCheck[];
};

/**
 * Rebuilds the database as it was at one moment: the base backup before
 * that moment goes into a fresh volume, the WAL after it is replayed in a
 * container on an internal network with no ports, and the result is
 * promoted and queried before anything is reported as recovered. The
 * running database is never touched.
 */
export const recoverToPointInTime = async (
	organizationId: string,
	policyId: string,
	options: RecoveryOptions,
	log: Log,
	redact: (value: string) => void,
): Promise<RecoveryOutcome> => {
	const { policy, repository } = await findPolicy(organizationId, policyId);
	const target = await walTarget(policy);
	const env = await repositoryEnv(repository);
	for (const value of Object.values(env)) redact(value);
	const repoMount = repoMountOf(repository);
	const where =
		options.serverId === undefined ? policy.serverId : options.serverId;
	const startedAt = Date.now();
	const checks: DrillCheck[] = [];

	const targetDate = options.targetTime ? new Date(options.targetTime) : null;
	if (targetDate && Number.isNaN(targetDate.getTime())) {
		throw new Error("The recovery target is not a valid time");
	}
	if (targetDate && targetDate.getTime() > Date.now()) {
		throw new Error("The recovery target is in the future");
	}

	const base = await latestBase(policy.id, targetDate ?? undefined);
	if (!base?.snapshotId || !base.walStart) {
		throw new Error(
			targetDate
				? "There is no base backup from before that moment"
				: "There is no base backup yet",
		);
	}

	// Everything archived so far has to be in the repository first. This
	// works with the database down, which is the usual time to be here.
	if (policy.walEnabled) {
		await log("Shipping the latest WAL…");
		await shipWal(organizationId, policyId, log, redact, {
			switchSegment: true,
		}).catch((error) => log(`Could not ship first: ${String(error)}`));
	}

	const listed = await runWhereDataIs(
		where,
		`${envPrefix(env)} ${resticCommand(
			[
				"snapshots",
				"--json",
				`--tag ${quote(`${WAL_TAG},${walPolicyTag(policy.id)}`)}`,
			],
			{ env, repoMount },
		)}`,
		{ timeoutMs: 300_000 },
	);
	const walSnapshots = parseSnapshots(listed.stdout).sort((a, b) =>
		a.time.localeCompare(b.time),
	);
	const needed = targetDate
		? targetDate.getTime() + SNAPSHOT_MARGIN_MS
		: Number.POSITIVE_INFINITY;
	const walSnapshot =
		walSnapshots.find((snapshot) => Date.parse(snapshot.time) >= needed) ??
		walSnapshots.at(-1);
	if (!walSnapshot) throw new Error("No WAL has been shipped yet");

	const id = `abhash-pitr-${nanoid(8)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "x")}`;
	const dataVolume = `${id}-data`;
	const walVolume = `${id}-wal`;
	const restoredWal = `/wal-restore${WAL_MOUNT_PATH}/wal`;
	const psql = (sql: string) =>
		`docker exec ${id} psql -X -U ${quote(target.username)} -d ${quote(target.database)} -tAc ${quote(sql)}`;
	const teardown = (keepData: boolean) =>
		[
			`docker stop -t 120 ${id} >/dev/null 2>&1`,
			`docker rm -f ${id} >/dev/null 2>&1`,
			`docker network rm ${id} >/dev/null 2>&1`,
			`docker volume rm ${walVolume} >/dev/null 2>&1`,
			keepData ? "" : `docker volume rm ${dataVolume} >/dev/null 2>&1`,
			"true",
		]
			.filter(Boolean)
			.join("; ");
	let recovered = false;

	try {
		await log(
			`Restoring base backup ${base.snapshotId.slice(0, 8)} and WAL ${walSnapshot.shortId}…`,
		);
		// The base streams from restic straight into the volume through a
		// pipe, so a second copy of the database is never written to disk.
		const restore = [
			"set -e",
			`docker volume create --label com.abhash.pitr=1 ${dataVolume} >/dev/null`,
			`docker volume create --label com.abhash.pitr=1 ${walVolume} >/dev/null`,
			"WORK=$(mktemp -d)",
			"trap 'rm -rf \"$WORK\"' EXIT",
			'mkfifo "$WORK/stream"',
			`( ${envPrefix(env)} ${resticCommand(
				["dump", base.snapshotId, `/${baseBackupFilename(target.appName)}`],
				{ env, repoMount },
			)} > "$WORK/stream"; echo $? > "$WORK/dump.status" ) &`,
			`docker run --rm -i --network none -u 0 --entrypoint sh -v ${dataVolume}:/pgdata ${quote(target.image)} -c 'tar -xf - -C /pgdata' < "$WORK/stream"`,
			"wait",
			'[ "$(cat "$WORK/dump.status" 2>/dev/null || echo 1)" = 0 ]',
			`${envPrefix(env)} ${resticCommand(
				["restore", walSnapshot.id, "--target /wal-restore"],
				{ env, repoMount, volumes: [`${walVolume}:/wal-restore`] },
			)} >/dev/null`,
		].join("\n");
		const restored = await runWhereDataIs(where, restore, {
			timeoutMs: 6 * 60 * 60_000,
		});
		if (restored.exitCode !== 0) {
			throw new Error(
				`Could not restore the backup: ${(restored.stderr || restored.stdout).slice(-400)}`,
			);
		}

		const segments = await runWhereDataIs(
			where,
			`docker run --rm --network none -v ${walVolume}:/wal-restore:ro alpine:3.20 ls -1 ${restoredWal}`,
			{ timeoutMs: 120_000 },
		);
		const gap = findSegmentGap(
			segments.stdout.split("\n").map((line) => line.trim()),
			base.walStart,
		);
		checks.push({
			name: "The WAL is unbroken",
			ok: gap.ok,
			detail: gap.ok
				? `through ${gap.last ?? "the base backup"}`
				: `${gap.missing} is missing`,
		});
		if (!gap.ok) {
			throw new Error(
				`The archive has a hole at ${gap.missing}, so recovery cannot pass it`,
			);
		}

		const settings = recoverySettings({
			walRestorePath: restoredWal,
			targetTime: targetDate,
		});
		const start = [
			"set -e",
			`docker run --rm -i --network none -u 0 --entrypoint sh -v ${dataVolume}:/pgdata ${quote(target.image)} -c ${quote(
				"cat >> /pgdata/postgresql.auto.conf && touch /pgdata/recovery.signal && rm -f /pgdata/postmaster.pid && chown -R postgres:postgres /pgdata && chmod 0700 /pgdata",
			)} <<'ABHASH_PITR'\n${settings}ABHASH_PITR`,
			`docker network create --internal ${id} >/dev/null`,
			`docker run -d --name ${id} --network ${id} --memory 1g -e PGDATA=/pgdata -v ${dataVolume}:/pgdata -v ${walVolume}:/wal-restore:ro ${quote(target.image)} >/dev/null`,
		].join("\n");
		const started = await runWhereDataIs(where, start, { timeoutMs: 300_000 });
		if (started.exitCode !== 0) {
			throw new Error(
				`Could not start the recovery: ${(started.stderr || started.stdout).slice(-300)}`,
			);
		}

		await log("Replaying WAL…");
		const deadline = Date.now() + (options.timeoutMinutes ?? 240) * 60_000;
		for (;;) {
			const state = await runWhereDataIs(
				where,
				psql("select pg_is_in_recovery()"),
				{
					timeoutMs: 60_000,
				},
			);
			if (state.exitCode === 0 && state.stdout.trim() === "f") break;
			const running = await runWhereDataIs(
				where,
				`docker inspect -f '{{.State.Running}}' ${id}`,
				{ timeoutMs: 60_000 },
			);
			if (running.stdout.trim() !== "true") {
				const logs = await runWhereDataIs(
					where,
					`docker inspect -f 'exit {{.State.ExitCode}} {{.State.Error}}' ${id} 2>&1; docker logs --tail 15 ${id} 2>&1`,
					{ timeoutMs: 60_000 },
				);
				const tail = logs.stdout.slice(-600);
				throw new Error(
					/before configured recovery target was reached/.test(tail)
						? "The archive ends before that moment. Recover to the latest point instead."
						: `Recovery stopped: ${tail}`,
				);
			}
			if (Date.now() > deadline) throw new Error("Recovery ran out of time");
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		checks.push({ name: "Recovery completes", ok: true, detail: "promoted" });

		const query = async (sql: string) => {
			const result = await runWhereDataIs(where, psql(sql), {
				timeoutMs: 120_000,
			});
			return { ok: result.exitCode === 0, value: result.stdout.trim() };
		};
		const counted = await query(
			"select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')",
		);
		const tables = Number(counted.value);
		checks.push({
			name: "The data is there",
			ok: counted.ok && Number.isFinite(tables),
			detail: `${counted.value} tables`,
		});
		await options.verify?.(query);

		recovered = checks.every((check) => check.ok);
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		await log(`Recovered in ${seconds}s`);
		return {
			volume: options.keepVolume && recovered ? dataVolume : null,
			baseSnapshotId: base.snapshotId,
			walSnapshotId: walSnapshot.id,
			recoveredTo: targetDate ? targetDate.toISOString() : "latest",
			tables: Number.isFinite(tables) ? tables : 0,
			seconds,
			checks,
		};
	} finally {
		// A copy of the data must never be left running, and a failed
		// recovery leaves no volume behind either.
		await runWhereDataIs(where, teardown(options.keepVolume && recovered), {
			timeoutMs: 300_000,
		}).catch(() => {});
	}
};

/**
 * Puts a recovered volume in place of the live data. The old data is copied
 * aside first and kept, so this can be undone by hand. `stop` and `start`
 * are the caller's: a Swarm service scales to zero and redeploys.
 */
export const replaceDataCommand = (options: {
	recoveredVolume: string;
	liveVolume: string;
	/** PGDATA relative to where the live volume is mounted; "" before 18. */
	dataSubpath: string;
	safetyVolume: string;
	walVolume: string;
}) => {
	const live = `/live${options.dataSubpath ? `/${options.dataSubpath}` : ""}`;
	// The copy was promoted with archiving off, so the history file of the
	// timeline it started never reached the archive. Without it, a later
	// recovery from an older base could not follow onto the new timeline.
	const archiveHistory = `for h in ${live}/pg_wal/*.history; do [ -f "$h" ] || continue; n=$(basename "$h"); [ -f "/wal/wal/$n.gz" ] || { gzip -c "$h" > "/wal/wal/$n.gz" && chown "$(stat -c %u:%g /wal/wal)" "/wal/wal/$n.gz"; }; done`;
	return [
		"set -e",
		`docker volume create --label com.abhash.pitr=1 ${quote(options.safetyVolume)} >/dev/null`,
		`docker run --rm --network none -v ${quote(options.liveVolume)}:/live -v ${quote(options.safetyVolume)}:/safety -v ${quote(options.recoveredVolume)}:/recovered:ro -v ${quote(options.walVolume)}:/wal alpine:3.20 sh -c ${quote(
			[
				"set -e",
				"cp -a /live/. /safety/",
				`mkdir -p ${live}`,
				`find ${live} -mindepth 1 -delete`,
				`cp -a /recovered/. ${live}/`,
				// The copy ran with archiving off; the live database archives.
				`sed -i '/^# abhash point-in-time recovery$/,$d' ${live}/postgresql.auto.conf`,
				archiveHistory,
			].join(" && "),
		)}`,
	].join("\n");
};

/**
 * Recovers to a moment and swaps the result in for the live database. The
 * recovery is verified before the service is stopped, the old data is kept
 * in a volume of its own, and a new base backup follows, because the
 * recovered database continues on a new timeline.
 */
export const recoverInPlace = async (
	organizationId: string,
	policyId: string,
	targetTime: string | null,
	log: Log,
	redact: (value: string) => void,
) => {
	const { policy } = await findPolicy(organizationId, policyId);
	const target = await walTarget(policy);
	const volumes = await db.query.mounts.findMany({
		where: and(eq(mounts.postgresId, policy.target), eq(mounts.type, "volume")),
	});
	const live = volumes.find((mount) =>
		mount.mountPath.startsWith("/var/lib/postgresql"),
	);
	if (!live?.volumeName) {
		throw new Error("This database does not keep its data in a named volume");
	}

	const image = await runWhereDataIs(
		policy.serverId,
		`docker image inspect ${quote(target.image)} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
		{ timeoutMs: 120_000 },
	);
	const pgdata =
		image.stdout
			.split("\n")
			.find((line) => line.startsWith("PGDATA="))
			?.slice("PGDATA=".length)
			.trim() || "/var/lib/postgresql/data";
	const dataSubpath = dataSubpathOf(pgdata, live.mountPath);

	const outcome = await recoverToPointInTime(
		organizationId,
		policyId,
		{ targetTime, keepVolume: true },
		log,
		redact,
	);
	if (!outcome.volume)
		throw new Error("The recovery did not verify; nothing was changed");

	const safetyVolume = `${target.appName}-before-pitr-${Date.now()}`;
	const { stopService, stopServiceRemote } = await import(
		"../../../utils/docker/utils"
	);
	await log("Stopping the database…");
	if (policy.serverId) await stopServiceRemote(policy.serverId, target.appName);
	else await stopService(target.appName);
	const drained = await runWhereDataIs(
		policy.serverId,
		`for i in $(seq 1 60); do [ -z "$(docker ps -q --filter label=com.docker.swarm.service.name=${target.appName})" ] && exit 0; sleep 2; done; exit 1`,
		{ timeoutMs: 180_000 },
	);
	if (drained.exitCode !== 0) {
		throw new Error("The database did not stop; nothing was changed");
	}

	await log(`Keeping the old data in ${safetyVolume}, then swapping…`);
	const swapped = await runWhereDataIs(
		policy.serverId,
		replaceDataCommand({
			recoveredVolume: outcome.volume,
			liveVolume: live.volumeName,
			dataSubpath,
			safetyVolume,
			walVolume: walVolumeName(target.appName),
		}),
		{ timeoutMs: 6 * 60 * 60_000 },
	);
	const { deployPostgres } = await import("../../postgres");
	if (swapped.exitCode !== 0) {
		await deployPostgres(policy.target).catch(() => null);
		throw new Error(
			`The swap failed: ${(swapped.stderr || swapped.stdout).slice(-300)}. The old data is in ${safetyVolume}.`,
		);
	}
	await deployPostgres(policy.target, (line) => void log(String(line)));
	await runWhereDataIs(
		policy.serverId,
		`docker volume rm ${quote(outcome.volume)} >/dev/null 2>&1; true`,
		{ timeoutMs: 120_000 },
	);
	return { ...outcome, volume: null, safetyVolume };
};
