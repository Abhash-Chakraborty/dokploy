/**
 * Continuous WAL archiving for Postgres, as strings and parsers only.
 *
 * Postgres hands every finished WAL segment to `archive_command`, which
 * compresses it into a volume of its own. A job ships that volume into the
 * policy's restic repository every few minutes. With a physical base backup
 * and the WAL written since, the database can be rebuilt as it was at any
 * moment, not only as it was at the last dump.
 */

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export const WAL_MOUNT_PATH = "/wal-archive";
const WAL_DIR = `${WAL_MOUNT_PATH}/wal`;
const ARCHIVE_SCRIPT = `${WAL_MOUNT_PATH}/archive.sh`;

/** Snapshots of the WAL volume are told apart from base backups by this. */
export const WAL_TAG = "wal";
export const BASE_TAG = "base";

export const walVolumeName = (appName: string) => `${appName}-wal`;
export const baseBackupFilename = (appName: string) =>
	`${appName}.basebackup.tar`;

/** A segment, a timeline history file, or a backup label. */
const ARCHIVED_FILE =
	/^[0-9A-F]{8}(\.history|[0-9A-F]{16}(\.[0-9A-F]{8}\.backup)?)\.gz$/;
const SEGMENT_NAME = /^[0-9A-F]{24}$/;

export const isSegmentName = (value: string) => SEGMENT_NAME.test(value);

/**
 * Runs inside the database container, so it sticks to what both the Debian
 * and the Alpine images have: sh, gzip, cmp and mv.
 *
 * - The segment is written under a temporary name and renamed, so a crash
 *   never leaves half a file under the real one.
 * - After a crash Postgres may hand over a segment it already archived.
 *   The same bytes again are a success; different bytes are refused, since
 *   overwriting would corrupt the archive.
 */
export const ARCHIVE_SCRIPT_BODY = `#!/bin/sh
set -eu
src="$1"
name="$2"
dir=${WAL_DIR}
dest="$dir/$name.gz"
if [ -f "$dest" ]; then
	if gzip -dc "$dest" | cmp -s - "$src"; then exit 0; fi
	echo "refusing to overwrite a different $name" >&2
	exit 1
fi
tmp="$dir/.$name.$$"
trap 'rm -f "$tmp"' EXIT
gzip -1 -c "$src" > "$tmp"
sync "$tmp" 2>/dev/null || true
mv "$tmp" "$dest"
`;

const containerOf = (appName: string) =>
	`$(docker ps --filter "label=com.docker.swarm.service.name=${appName}" --filter "status=running" -q | head -1)`;

const psql = (
	target: { appName: string; username: string; database: string },
	sql: string,
) =>
	`docker exec ${containerOf(target.appName)} psql -X -v ON_ERROR_STOP=1 -U ${shellQuote(target.username)} -d ${shellQuote(target.database)} -tA -F '|' -c ${shellQuote(sql)}`;

/**
 * Puts the script in place and hands the volume to whoever Postgres runs
 * as, which differs between images, so it is asked rather than assumed.
 */
export const prepareArchiveCommand = (appName: string) => {
	const container = containerOf(appName);
	return [
		"set -e",
		`C=${container}`,
		'[ -n "$C" ] || { echo "The database is not running" >&2; exit 1; }',
		`docker exec -u 0 "$C" sh -c ${shellQuote(`mkdir -p ${WAL_DIR} && [ -w ${WAL_MOUNT_PATH} ]`)} || { echo "The WAL volume is not mounted at ${WAL_MOUNT_PATH}" >&2; exit 1; }`,
		`docker exec -i -u 0 "$C" sh -c ${shellQuote(`cat > ${ARCHIVE_SCRIPT} && chmod 0755 ${ARCHIVE_SCRIPT}`)} <<'ABHASH_WAL_SCRIPT'\n${ARCHIVE_SCRIPT_BODY}ABHASH_WAL_SCRIPT`,
		`docker exec -u 0 "$C" sh -c ${shellQuote(`chown -R "$(stat -c %u:%g "$PGDATA")" ${WAL_MOUNT_PATH}`)}`,
	].join("\n");
};

/**
 * ALTER SYSTEM writes to postgresql.auto.conf inside the data volume, so
 * the settings survive a redeploy without touching the service's command.
 * `wal_level` is only raised, never lowered: `logical` also archives.
 */
export const enableArchivingCommand = (
	target: { appName: string; username: string; database: string },
	archiveTimeoutSeconds: number,
) =>
	[
		"set -e",
		psql(target, "ALTER SYSTEM SET archive_mode = 'on'"),
		psql(
			target,
			`ALTER SYSTEM SET archive_command = '/bin/sh ${ARCHIVE_SCRIPT} "%p" "%f"'`,
		),
		psql(
			target,
			`ALTER SYSTEM SET archive_timeout = '${Math.round(archiveTimeoutSeconds)}s'`,
		),
		`if [ "$(${psql(target, "SHOW wal_level")})" = minimal ]; then ${psql(target, "ALTER SYSTEM SET wal_level = 'replica'")}; fi`,
		psql(target, "SELECT pg_reload_conf()"),
	].join("\n");

/**
 * Turning `archive_mode` off needs a restart, and until then an empty
 * `archive_command` would make Postgres keep every segment forever. A
 * command that always succeeds lets it recycle them straight away.
 */
export const disableArchivingCommand = (target: {
	appName: string;
	username: string;
	database: string;
}) =>
	[
		"set -e",
		psql(target, "ALTER SYSTEM SET archive_command = '/bin/true'"),
		psql(target, "ALTER SYSTEM RESET archive_mode"),
		psql(target, "ALTER SYSTEM RESET archive_timeout"),
		psql(target, "SELECT pg_reload_conf()"),
	].join("\n");

export type ArchiverStatus = {
	/** What the running server is actually doing, not what is configured. */
	archiveMode: string;
	/** True while `archive_mode` waits for a restart to take effect. */
	pendingRestart: boolean;
	lastArchivedWal: string | null;
	lastArchivedAt: string | null;
	failedCount: number;
	lastFailedWal: string | null;
	currentWal: string;
	/** Seconds since a segment last reached the archive; null if none has. */
	lagSeconds: number | null;
	/**
	 * Finished segments still waiting to be archived. An idle database
	 * writes no WAL, so a long silence is normal; a queue is not.
	 */
	pendingSegments: number;
};

export const archiverStatusCommand = (target: {
	appName: string;
	username: string;
	database: string;
}) =>
	psql(
		target,
		`SELECT current_setting('archive_mode'),
			(SELECT pending_restart FROM pg_settings WHERE name = 'archive_mode'),
			coalesce(last_archived_wal, ''),
			coalesce(to_char(last_archived_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
			failed_count,
			coalesce(last_failed_wal, ''),
			pg_walfile_name(pg_current_wal_lsn()),
			coalesce(extract(epoch FROM now() - last_archived_time)::bigint::text, ''),
			(SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready')
		FROM pg_stat_archiver`,
	);

export const parseArchiverStatus = (output: string): ArchiverStatus | null => {
	const line = output
		.split("\n")
		.map((value) => value.trim())
		.find((value) => value.split("|").length === 9);
	if (!line) return null;
	const [
		mode,
		pending,
		lastWal,
		lastAt,
		failed,
		lastFailed,
		current,
		lag,
		ready,
	] = line.split("|") as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	return {
		archiveMode: mode,
		pendingRestart: pending === "t",
		lastArchivedWal: lastWal || null,
		lastArchivedAt: lastAt || null,
		failedCount: Number(failed) || 0,
		lastFailedWal: lastFailed || null,
		currentWal: current,
		lagSeconds: lag === "" ? null : Number(lag),
		pendingSegments: Number(ready) || 0,
	};
};

/** The segment being written now: a lower bound for a base backup's start. */
export const currentWalCommand = (target: {
	appName: string;
	username: string;
	database: string;
}) => psql(target, "SELECT pg_walfile_name(pg_current_wal_lsn())");

/** Closes the current segment so it reaches the archive without waiting. */
export const switchWalCommand = (target: {
	appName: string;
	username: string;
	database: string;
}) => psql(target, "SELECT pg_switch_wal()");

/**
 * A physical copy of the whole cluster as one tar stream. `-X fetch` puts
 * the WAL written during the copy into the same tar, so the base backup can
 * be restored by itself even if the archive were lost.
 */
export const baseBackupDumpCommand = (target: {
	appName: string;
	username: string;
}) =>
	`docker exec ${containerOf(target.appName)} pg_basebackup -U ${shellQuote(target.username)} -D - -Ft -X fetch -c fast --no-manifest --no-password`;

export const listArchiveCommand = (appName: string) =>
	`docker run --rm -v ${shellQuote(walVolumeName(appName))}:${WAL_MOUNT_PATH}:ro alpine:3.20 sh -c ${shellQuote(`ls -1 ${WAL_DIR} 2>/dev/null || true`)}`;

/**
 * What can go from the local archive once `keepFrom` starts the newest base
 * backup: recovery never reaches back past the base it starts from, and
 * everything listed here is already in an earlier snapshot. Timeline
 * history files are tiny and always needed, so they stay.
 */
export const prunableArchiveFiles = (files: string[], keepFrom: string) => {
	if (!isSegmentName(keepFrom)) return [];
	return files.filter((file) => {
		if (!ARCHIVED_FILE.test(file) || file.includes(".history")) return false;
		return file.slice(0, 24) < keepFrom;
	});
};

export const pruneArchiveCommand = (appName: string, files: string[]) => {
	const safe = files.filter((file) => ARCHIVED_FILE.test(file));
	if (safe.length === 0) return null;
	return `docker run --rm -i -v ${shellQuote(walVolumeName(appName))}:${WAL_MOUNT_PATH} alpine:3.20 sh -c ${shellQuote(`cd ${WAL_DIR} && xargs rm -f --`)} <<'ABHASH_WAL_PRUNE'\n${safe.join("\n")}\nABHASH_WAL_PRUNE`;
};

/** Are the segments from `from` onwards all there, with no hole? */
export const findSegmentGap = (
	files: string[],
	from: string,
	segmentsPerLogicalFile = 256,
): { ok: true; last: string | null } | { ok: false; missing: string } => {
	const timeline = from.slice(0, 8);
	const present = new Set(
		files
			.map((file) => file.replace(/\.gz$/, ""))
			.filter((file) => isSegmentName(file) && file.startsWith(timeline)),
	);
	const number = (name: string) =>
		BigInt(`0x${name.slice(8, 16)}`) * BigInt(segmentsPerLogicalFile) +
		BigInt(`0x${name.slice(16, 24)}`);
	const name = (value: bigint) => {
		const high = value / BigInt(segmentsPerLogicalFile);
		const low = value % BigInt(segmentsPerLogicalFile);
		return `${timeline}${high.toString(16).toUpperCase().padStart(8, "0")}${low.toString(16).toUpperCase().padStart(8, "0")}`;
	};
	const later = [...present].filter((file) => file >= from).sort();
	if (later.length === 0) return { ok: true, last: null };
	const last = later[later.length - 1] as string;
	for (let value = number(from); value <= number(last); value++) {
		if (!present.has(name(value))) return { ok: false, missing: name(value) };
	}
	return { ok: true, last };
};

/**
 * `recovery_target_time` is parsed while the configuration loads, before
 * time zone abbreviations can be resolved, and `Z` is one. Postgres asks
 * for a numeric offset instead.
 */
export const recoveryTargetTime = (date: Date) =>
	`${date.toISOString().replace("T", " ").replace("Z", "")}+00`;

/**
 * Settings for the recovered copy, appended to postgresql.auto.conf where
 * the last line wins. Archiving is switched off: the copy must never write
 * into the archive of the database it was recovered from.
 */
export const recoverySettings = (options: {
	walRestorePath: string;
	targetTime: Date | null;
}) =>
	[
		"# abhash point-in-time recovery",
		`restore_command = 'gzip -dc ${options.walRestorePath}/%f.gz > "%p"'`,
		...(options.targetTime
			? [
					`recovery_target_time = '${recoveryTargetTime(options.targetTime)}'`,
					"recovery_target_inclusive = 'true'",
				]
			: []),
		"recovery_target_timeline = 'latest'",
		"recovery_target_action = 'promote'",
		"archive_mode = 'off'",
		"",
	].join("\n");

/** PGDATA relative to the volume's mount point: "" up to 17, "18/docker" on 18. */
export const dataSubpathOf = (pgdata: string, mountPath: string) => {
	const data = pgdata.replace(/\/+$/, "");
	const mount = mountPath.replace(/\/+$/, "");
	if (data === mount) return "";
	if (!data.startsWith(`${mount}/`)) {
		throw new Error(
			`PGDATA ${pgdata} is not inside the volume at ${mountPath}`,
		);
	}
	return data.slice(mount.length + 1);
};
