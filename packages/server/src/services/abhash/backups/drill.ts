import { and, desc, eq, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../../db";
import {
	abhashBackupRun,
	abhashDrillPolicy,
	abhashDrillRun,
	type BackupTargetKind,
	type DrillCheck,
} from "../../../db/schema";
import { emitEvent } from "../webhooks";
import { dumpPlan, envPrefix, resticCommand } from "./restic";
import {
	findPolicy,
	repoMountOf,
	repositoryEnv,
	resolveTarget,
	runWhereDataIs,
} from "./service";

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

type DrillPlan = {
	image: string;
	env: string[];
	ready: string;
	restore: (snapshotFile: string) => string;
	countTables?: string;
	query?: (sql: string) => string;
};

const PASSWORD = "drill";

/** How each engine is brought up empty and fed the snapshot back. */
export const drillPlan = (
	kind: BackupTargetKind,
	options: { image: string; database: string; username: string; name: string },
): DrillPlan => {
	switch (kind) {
		case "postgres":
			return {
				image: options.image,
				env: [
					`POSTGRES_PASSWORD=${PASSWORD}`,
					`POSTGRES_USER=${options.username}`,
					`POSTGRES_DB=${options.database}`,
				],
				ready: `docker exec ${options.name} pg_isready -U ${quote(options.username)} -d ${quote(options.database)}`,
				restore: (file) =>
					`docker exec -i ${options.name} pg_restore --clean --if-exists --no-owner --no-acl -U ${quote(options.username)} -d ${quote(options.database)} < ${file}`,
				countTables: `docker exec ${options.name} psql -U ${quote(options.username)} -d ${quote(options.database)} -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`,
				query: (sql) =>
					`docker exec ${options.name} psql -U ${quote(options.username)} -d ${quote(options.database)} -tAc ${quote(sql)}`,
			};
		case "mysql":
		case "mariadb": {
			const client = kind === "mysql" ? "mysql" : "mariadb";
			return {
				image: options.image,
				env: [
					`MYSQL_ROOT_PASSWORD=${PASSWORD}`,
					`MARIADB_ROOT_PASSWORD=${PASSWORD}`,
					`MYSQL_DATABASE=${options.database}`,
				],
				ready: `docker exec ${options.name} sh -c '${client}admin ping -uroot -p${PASSWORD} --silent'`,
				restore: (file) =>
					`docker exec -i ${options.name} sh -c '${client} -uroot -p${PASSWORD} ${quote(options.database)}' < ${file}`,
				countTables: `docker exec ${options.name} sh -c '${client} -uroot -p${PASSWORD} -N -B -e "select count(*) from information_schema.tables where table_schema = \\"${options.database}\\""'`,
				query: (sql) =>
					`docker exec ${options.name} sh -c '${client} -uroot -p${PASSWORD} -N -B -e ${quote(sql)}'`,
			};
		}
		case "mongo":
			return {
				image: options.image,
				env: [],
				ready: `docker exec ${options.name} mongosh --quiet --eval 'db.runCommand({ping:1}).ok'`,
				restore: (file) =>
					`docker exec -i ${options.name} mongorestore --archive --gzip --drop --quiet < ${file}`,
				countTables: `docker exec ${options.name} mongosh --quiet --eval 'db.getMongo().getDBNames().length'`,
			};
		case "redis":
			return {
				image: options.image,
				env: [],
				ready: `docker exec ${options.name} redis-cli ping`,
				restore: (file) =>
					`docker cp ${file} ${options.name}:/data/dump.rdb && docker restart ${options.name} >/dev/null && sleep 3`,
				countTables: `docker exec ${options.name} redis-cli dbsize`,
			};
		default:
			throw new Error(`Drills do not cover ${kind} yet`);
	}
};

export type DrillOutcome = {
	status: "passed" | "failed";
	rtoSeconds: number;
	checks: DrillCheck[];
	snapshotId: string | null;
};

/**
 * Restores the latest snapshot into a throwaway container on an internal
 * network with no published ports, checks it against what was recorded at
 * backup time, and always tears the container down again.
 */
export const runDrill = async (
	organizationId: string,
	drillPolicyId: string,
	log: (line: string) => Promise<void> | void,
	redact: (value: string) => void,
): Promise<DrillOutcome> => {
	const drill = await db.query.abhashDrillPolicy.findFirst({
		where: and(
			eq(abhashDrillPolicy.id, drillPolicyId),
			eq(abhashDrillPolicy.organizationId, organizationId),
		),
	});
	if (!drill) throw new Error("Drill not found");
	const { policy, repository } = await findPolicy(
		organizationId,
		drill.policyId,
	);
	const env = await repositoryEnv(repository);
	for (const value of Object.values(env)) redact(value);
	const target = await resolveTarget(policy);
	const plan = dumpPlan(policy.targetKind, target);

	const previous = await db.query.abhashBackupRun.findFirst({
		where: and(
			eq(abhashBackupRun.policyId, policy.id),
			eq(abhashBackupRun.status, "succeeded"),
			isNotNull(abhashBackupRun.snapshotId),
		),
		orderBy: [desc(abhashBackupRun.startedAt)],
	});
	if (!previous?.snapshotId) {
		throw new Error("There is no successful backup to restore yet");
	}

	const where =
		drill.where === "drill-server" ? drill.drillServerId : policy.serverId;
	if (previous.method === "base") {
		return runRecoveryDrill({
			organizationId,
			drill,
			policyName: policy.name,
			snapshotId: previous.snapshotId,
			expectedTables: previous.stats?.tables,
			where,
			log,
			redact,
		});
	}
	const id = nanoid(8).toLowerCase();
	const name = `abhash-drill-${id}`;
	const network = `abhash-drill-${id}`;
	const scratch = `/tmp/${name}`;
	const engine = drillPlan(policy.targetKind, {
		image: (target as { image?: string }).image ?? "postgres:18",
		database: (target as { database?: string }).database ?? "postgres",
		username: (target as { username?: string }).username ?? "postgres",
		name,
	});

	const [run] = await db
		.insert(abhashDrillRun)
		.values({
			drillPolicyId: drill.id,
			snapshotId: previous.snapshotId,
			status: "running",
		})
		.returning();
	const runId = run?.id as string;
	const startedAt = Date.now();
	const checks: DrillCheck[] = [];

	const cleanup = `docker rm -f ${name} >/dev/null 2>&1; docker network rm ${network} >/dev/null 2>&1; rm -rf ${scratch}; true`;

	try {
		await log(`Restoring snapshot ${previous.snapshotId.slice(0, 8)}…`);
		// No published ports and an internal network: the copy cannot be
		// reached from anywhere, and cannot reach out.
		const setup = [
			cleanup,
			`mkdir -p ${scratch}`,
			`docker network create --internal ${network} >/dev/null`,
			`docker run -d --name ${name} --network ${network} ${engine.env
				.map((value) => `-e ${quote(value)}`)
				.join(" ")} --memory 1g ${engine.image} >/dev/null`,
		].join(" && ");
		const started = await runWhereDataIs(where, setup, { timeoutMs: 300_000 });
		if (started.exitCode !== 0) {
			throw new Error(
				`Could not start the copy: ${started.stderr.slice(-300)}`,
			);
		}

		const waitReady = `for i in $(seq 1 60); do ${engine.ready} >/dev/null 2>&1 && break; sleep 2; done; ${engine.ready}`;
		const ready = await runWhereDataIs(where, waitReady, {
			timeoutMs: 300_000,
		});
		checks.push({
			name: "The copy starts",
			ok: ready.exitCode === 0,
			detail: ready.exitCode === 0 ? "ready" : ready.stderr.slice(-200),
		});
		if (ready.exitCode !== 0)
			throw new Error("The restored copy never became ready");

		const dumpFile = `${scratch}/${plan.filename}`;
		const fetch = `${envPrefix(env)} ${resticCommand(
			["dump", previous.snapshotId, `/${plan.filename}`],
			{ env, repoMount: repoMountOf(repository) },
		)} > ${dumpFile}`;
		const fetched = await runWhereDataIs(where, fetch, {
			timeoutMs: 2 * 60 * 60_000,
		});
		if (fetched.exitCode !== 0) {
			throw new Error(
				`Could not read the snapshot: ${fetched.stderr.slice(-300)}`,
			);
		}

		const restored = await runWhereDataIs(where, engine.restore(dumpFile), {
			timeoutMs: 2 * 60 * 60_000,
		});
		checks.push({
			name: "The snapshot restores",
			ok: restored.exitCode === 0,
			detail:
				restored.exitCode === 0
					? "restored"
					: (restored.stderr || restored.stdout).slice(-300),
		});
		if (restored.exitCode !== 0) throw new Error("The restore failed");

		if (engine.countTables) {
			const counted = await runWhereDataIs(where, engine.countTables, {
				timeoutMs: 120_000,
			});
			const found = Number(counted.stdout.trim());
			const expected = previous.stats?.tables;
			const ok =
				Number.isFinite(found) &&
				found > 0 &&
				(expected === undefined || Math.abs(found - expected) <= 1);
			checks.push({
				name: "The data is there",
				ok,
				detail:
					expected === undefined
						? `${found} found`
						: `${found} found, ${expected} at backup time`,
			});
		}

		for (const query of drill.queries) {
			if (!engine.query) break;
			const result = await runWhereDataIs(where, engine.query(query.sql), {
				timeoutMs: 120_000,
			});
			const value = result.stdout.trim();
			const ok =
				result.exitCode === 0 &&
				(query.expect === undefined || value === query.expect);
			checks.push({
				name: query.name,
				ok,
				detail: query.expect ? `${value} (expected ${query.expect})` : value,
			});
		}

		const rtoSeconds = Math.round((Date.now() - startedAt) / 1000);
		const withinRto = rtoSeconds <= drill.rtoMinutes * 60;
		checks.push({
			name: "Within the recovery-time budget",
			ok: withinRto,
			detail: `${rtoSeconds}s of ${drill.rtoMinutes * 60}s`,
		});

		const status = checks.every((check) => check.ok) ? "passed" : "failed";
		if (status === "failed") {
			await emitEvent(organizationId, "drill.failed", {
				drillPolicyId: drill.id,
				policy: policy.name,
				checks: checks.filter((check) => !check.ok),
			});
		}
		await db
			.update(abhashDrillRun)
			.set({ status, rtoSeconds, checks, finishedAt: new Date() })
			.where(eq(abhashDrillRun.id, runId));
		await log(`Drill ${status} in ${rtoSeconds}s`);
		return { status, rtoSeconds, checks, snapshotId: previous.snapshotId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(abhashDrillRun)
			.set({
				status: "failed",
				error: message,
				checks,
				rtoSeconds: Math.round((Date.now() - startedAt) / 1000),
				finishedAt: new Date(),
			})
			.where(eq(abhashDrillRun.id, runId));
		throw error;
	} finally {
		// Always: a drill must never leave a copy of your data running.
		await runWhereDataIs(where, cleanup, { timeoutMs: 120_000 }).catch(
			() => {},
		);
	}
};

/**
 * For a policy with WAL archiving the drill is a real point-in-time
 * recovery: base backup, WAL replay to the latest moment, promotion, and
 * the same checks, all in a copy that is thrown away afterwards.
 */
const runRecoveryDrill = async (options: {
	organizationId: string;
	drill: typeof abhashDrillPolicy.$inferSelect;
	policyName: string;
	snapshotId: string;
	expectedTables: number | undefined;
	where: string | null;
	log: (line: string) => Promise<void> | void;
	redact: (value: string) => void;
}): Promise<DrillOutcome> => {
	const { drill } = options;
	const { recoverToPointInTime } = await import("./pitr");
	const [run] = await db
		.insert(abhashDrillRun)
		.values({
			drillPolicyId: drill.id,
			snapshotId: options.snapshotId,
			status: "running",
		})
		.returning();
	const runId = run?.id as string;
	const startedAt = Date.now();
	const checks: DrillCheck[] = [];
	try {
		const outcome = await recoverToPointInTime(
			options.organizationId,
			drill.policyId,
			{
				targetTime: null,
				keepVolume: false,
				serverId: options.where,
				verify: async (query) => {
					for (const assertion of drill.queries) {
						const result = await query(assertion.sql);
						checks.push({
							name: assertion.name,
							ok:
								result.ok &&
								(assertion.expect === undefined ||
									result.value === assertion.expect),
							detail: assertion.expect
								? `${result.value} (expected ${assertion.expect})`
								: result.value,
						});
					}
				},
			},
			options.log,
			options.redact,
		);
		checks.unshift(...outcome.checks);
		if (options.expectedTables !== undefined) {
			checks.push({
				name: "Nothing went missing",
				ok: outcome.tables >= options.expectedTables,
				detail: `${outcome.tables} tables, ${options.expectedTables} at backup time`,
			});
		}
		const rtoSeconds = Math.round((Date.now() - startedAt) / 1000);
		checks.push({
			name: "Within the recovery-time budget",
			ok: rtoSeconds <= drill.rtoMinutes * 60,
			detail: `${rtoSeconds}s of ${drill.rtoMinutes * 60}s`,
		});
		const status = checks.every((check) => check.ok) ? "passed" : "failed";
		if (status === "failed") {
			await emitEvent(options.organizationId, "drill.failed", {
				drillPolicyId: drill.id,
				policy: options.policyName,
				checks: checks.filter((check) => !check.ok),
			});
		}
		await db
			.update(abhashDrillRun)
			.set({ status, rtoSeconds, checks, finishedAt: new Date() })
			.where(eq(abhashDrillRun.id, runId));
		await options.log(`Drill ${status} in ${rtoSeconds}s`);
		return { status, rtoSeconds, checks, snapshotId: options.snapshotId };
	} catch (error) {
		await db
			.update(abhashDrillRun)
			.set({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				checks,
				rtoSeconds: Math.round((Date.now() - startedAt) / 1000),
				finishedAt: new Date(),
			})
			.where(eq(abhashDrillRun.id, runId));
		throw error;
	}
};
