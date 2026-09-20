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

/**
 * Per-object row counts as `name<TAB>count` lines, sorted, so the same command
 * shape can be run against the restored copy and the live database and the two
 * outputs compared directly.
 *
 * Postgres counts every table for real rather than reading the planner's
 * estimate: an estimate that happens to match proves nothing about whether the
 * rows actually came back. MySQL has no cheap exact equivalent, so its counts
 * are the engine's own and are treated as approximate.
 */
export const fingerprintCommand = (
	kind: BackupTargetKind,
	target: { container: string; database: string; username: string },
): string | null => {
	const { container, database, username } = target;
	switch (kind) {
		case "postgres":
			return `docker exec ${container} psql -U ${quote(username)} -d ${quote(database)} -tAF'\t' -c ${quote(
				"select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint from information_schema.tables where table_schema not in ('pg_catalog','information_schema') and table_type = 'BASE TABLE' order by table_name",
			)}`;
		case "mysql":
		case "mariadb":
			return `docker exec ${container} sh -c ${quote(
				`exec ${kind === "mysql" ? "mysql" : "mariadb"} -u root -p"$MYSQL_ROOT_PASSWORD" -N -B -e "select table_name, table_rows from information_schema.tables where table_schema = '${database}' order by table_name"`,
			)}`;
		case "mongo":
			return `docker exec ${container} mongosh --quiet --eval ${quote(
				"db.getSiblingDB(process.env.MONGO_DB || 'test').getCollectionNames().sort().forEach(c => print(c + '\t' + db.getSiblingDB(process.env.MONGO_DB || 'test').getCollection(c).countDocuments()))",
			)}`;
		default:
			return null;
	}
};

export type FingerprintRow = { name: string; rows: number };

export const parseFingerprint = (stdout: string): FingerprintRow[] =>
	stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [name = "", count = ""] = line.split(/\t+/);
			return { name: name.trim(), rows: Number(count.trim()) };
		})
		.filter((row) => row.name.length > 0 && Number.isFinite(row.rows))
		.sort((a, b) => a.name.localeCompare(b.name));

export type LiveComparison = {
	ok: boolean;
	detail: string;
};

/**
 * A backup is older than the database it came from, so equal counts are not
 * the bar. What must hold is that nothing has gone missing: every object
 * present live is present in the restore, and nothing that holds rows live
 * came back empty. Rows added since the snapshot are expected and reported
 * rather than failed.
 */
export const compareToLive = (
	live: FingerprintRow[],
	restored: FingerprintRow[],
): LiveComparison => {
	if (live.length === 0) {
		return { ok: false, detail: "the live database reported no tables" };
	}
	const byName = new Map(restored.map((row) => [row.name, row.rows]));
	const missing = live
		.filter((row) => !byName.has(row.name))
		.map((r) => r.name);
	if (missing.length > 0) {
		return {
			ok: false,
			detail: `missing from the restore: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`,
		};
	}
	const emptied = live
		.filter((row) => row.rows > 0 && (byName.get(row.name) ?? 0) === 0)
		.map((row) => row.name);
	if (emptied.length > 0) {
		return {
			ok: false,
			detail: `empty in the restore but not live: ${emptied.slice(0, 5).join(", ")}`,
		};
	}
	const liveRows = live.reduce((total, row) => total + row.rows, 0);
	const restoredRows = restored.reduce((total, row) => total + row.rows, 0);
	const behind = liveRows - restoredRows;
	return {
		ok: true,
		detail:
			behind === 0
				? `${live.length} tables, ${liveRows} rows, identical`
				: `${live.length} tables, ${restoredRows} rows restored against ${liveRows} live (${behind} written since the snapshot)`,
	};
};

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

		if (drill.compareLive) {
			const liveContainer = `$(docker ps --filter "label=com.docker.swarm.service.name=${(target as { appName?: string }).appName ?? ""}" --filter "status=running" -q | head -1)`;
			const live = fingerprintCommand(policy.targetKind, {
				container: liveContainer,
				database: (target as { database?: string }).database ?? "postgres",
				username: (target as { username?: string }).username ?? "postgres",
			});
			const copy = fingerprintCommand(policy.targetKind, {
				container: name,
				database: (target as { database?: string }).database ?? "postgres",
				username: (target as { username?: string }).username ?? "postgres",
			});
			if (!live || !copy) {
				checks.push({
					name: "Matches the live database",
					ok: true,
					detail: `not supported for ${policy.targetKind}; skipped`,
				});
			} else {
				// The live read happens on the server that holds the data, which is
				// not necessarily where the restore was brought up.
				const liveOut = await runWhereDataIs(policy.serverId, live, {
					timeoutMs: 300_000,
				});
				const copyOut = await runWhereDataIs(where, copy, {
					timeoutMs: 300_000,
				});
				if (liveOut.exitCode !== 0 || copyOut.exitCode !== 0) {
					checks.push({
						name: "Matches the live database",
						ok: false,
						detail: (
							liveOut.stderr ||
							copyOut.stderr ||
							"could not read one of the two"
						).slice(-200),
					});
				} else {
					const result = compareToLive(
						parseFingerprint(liveOut.stdout),
						parseFingerprint(copyOut.stdout),
					);
					checks.push({
						name: "Matches the live database",
						ok: result.ok,
						detail: result.detail,
					});
				}
			}
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
