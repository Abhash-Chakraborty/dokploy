import type { BackupTargetKind, RetentionPolicy } from "../../../db/schema";

export const RESTIC_IMAGE = () =>
	process.env.ABHASH_RESTIC_IMAGE || "restic/restic:0.18.0";

/** Values are passed as env vars, never interpolated into the command. */
export type ResticEnv = Record<string, string>;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * restic runs in a throwaway container on the machine that holds the data,
 * so nothing has to be installed on the server and the credentials only
 * exist for the life of the command.
 */
export const resticCommand = (
	args: string[],
	options: {
		env: ResticEnv;
		/** For a local repository, the host path to mount. */
		repoMount?: string | null;
		stdin?: boolean;
		network?: "host" | "none";
	},
) => {
	const parts = [
		"docker run --rm",
		options.stdin ? "-i" : "",
		options.network === "none" ? "--network none" : "--network host",
		options.repoMount
			? `-v ${shellQuote(options.repoMount)}:${shellQuote(options.repoMount)}`
			: "",
		...Object.keys(options.env).map((key) => `-e ${key}`),
		RESTIC_IMAGE(),
		...args,
	];
	return parts.filter(Boolean).join(" ");
};

/** `KEY=value ...` prefix, kept separate so logs can redact the values. */
export const envPrefix = (env: ResticEnv) =>
	Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");

export const retentionArgs = (retention: RetentionPolicy) =>
	[
		`--keep-last ${retention.last}`,
		`--keep-daily ${retention.daily}`,
		`--keep-weekly ${retention.weekly}`,
		`--keep-monthly ${retention.monthly}`,
		`--keep-yearly ${retention.yearly}`,
	].join(" ");

export type DumpPlan = {
	/** Produces the backup stream on stdout. */
	command: string;
	/** What the snapshot is called inside the repository. */
	filename: string;
	/** Collects the numbers a drill later checks the restore against. */
	statsCommand?: string;
};

const containerOf = (appName: string) =>
	`$(docker ps --filter "label=com.docker.swarm.service.name=${appName}" --filter "status=running" -q | head -1)`;

/**
 * How each kind of target is turned into a stream. Every command fails
 * loudly: restic is told to discard the snapshot if the dump exits non-zero.
 */
export const dumpPlan = (
	kind: BackupTargetKind,
	target: {
		appName: string;
		database?: string;
		username?: string;
		password?: string;
		path?: string;
	},
): DumpPlan => {
	const container = containerOf(target.appName);
	switch (kind) {
		case "postgres":
			return {
				command: `docker exec ${container} pg_dump -Fc --no-acl --no-owner -U ${shellQuote(target.username ?? "postgres")} ${shellQuote(target.database ?? "postgres")}`,
				filename: `${target.appName}.dump`,
				statsCommand: `docker exec ${container} psql -U ${shellQuote(target.username ?? "postgres")} -d ${shellQuote(target.database ?? "postgres")} -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`,
			};
		case "mysql":
		case "mariadb":
			return {
				command: `docker exec ${container} sh -c 'exec ${kind === "mysql" ? "mysqldump" : "mariadb-dump"} --single-transaction --routines --triggers --events -u root -p"$${"MYSQL_ROOT_PASSWORD"}" ${shellQuote(target.database ?? "")}'`,
				filename: `${target.appName}.sql`,
				statsCommand: `docker exec ${container} sh -c 'exec ${kind === "mysql" ? "mysql" : "mariadb"} -u root -p"$${"MYSQL_ROOT_PASSWORD"}" -N -B -e "select count(*) from information_schema.tables where table_schema = \\"${target.database ?? ""}\\""'`,
			};
		case "mongo":
			return {
				command: `docker exec ${container} sh -c 'exec mongodump --archive --gzip --quiet'`,
				filename: `${target.appName}.archive.gz`,
			};
		case "redis":
			return {
				command: `docker exec ${container} sh -c 'exec redis-cli --no-auth-warning -a "$${"REDIS_PASSWORD"}" --rdb -'`,
				filename: `${target.appName}.rdb`,
			};
		case "volume":
			return {
				command: `docker run --rm -v ${shellQuote(target.appName)}:/data:ro alpine:3.20 tar -cf - -C /data .`,
				filename: `${target.appName}.tar`,
			};
		case "path":
		case "dokploy":
			return {
				command: `tar -cf - -C ${shellQuote(target.path ?? "/etc/dokploy")} .`,
				filename: `${(target.path ?? "dokploy").replace(/\W+/g, "-")}.tar`,
			};
		default:
			throw new Error(`No backup strategy for ${kind}`);
	}
};

/**
 * The whole backup as one shell command. The dump runs where the data is
 * (it needs the Docker CLI) and streams through a pipe into restic, so no
 * temporary copy of the database is ever written to disk. The dump's exit
 * status is kept and checked afterwards: a snapshot from a failed dump is
 * worse than no snapshot at all, so the caller drops it.
 */
export const backupCommand = (options: {
	dump: DumpPlan;
	env: ResticEnv;
	repoMount?: string | null;
	tags: string[];
}) => {
	const tags = options.tags.map((tag) => `--tag ${shellQuote(tag)}`).join(" ");
	const restic = resticCommand(
		[
			"backup",
			"--json",
			tags,
			`--stdin-filename ${shellQuote(options.dump.filename)}`,
			"--stdin",
		],
		{ env: options.env, repoMount: options.repoMount, stdin: true },
	);
	return [
		"set -e",
		"WORK=$(mktemp -d)",
		"trap 'rm -rf \"$WORK\"' EXIT",
		'mkfifo "$WORK/stream"',
		`( ${options.dump.command} > "$WORK/stream"; echo $? > "$WORK/dump.status" ) &`,
		`${envPrefix(options.env)} ${restic} < "$WORK/stream"`,
		"wait",
		'DUMP_STATUS=$(cat "$WORK/dump.status" 2>/dev/null || echo 1)',
		'echo "DUMP_STATUS=$DUMP_STATUS"',
		'[ "$DUMP_STATUS" = 0 ]',
	].join("\n");
};

/** Drops a snapshot, e.g. one written from a dump that then failed. */
export const forgetSnapshotCommand = (options: {
	snapshotId: string;
	env: ResticEnv;
	repoMount?: string | null;
}) =>
	`${envPrefix(options.env)} ${resticCommand(
		["forget", "--prune", options.snapshotId],
		{ env: options.env, repoMount: options.repoMount },
	)}`;

export type SnapshotSummary = {
	snapshotId: string;
	bytesAdded: number;
	bytesProcessed: number;
	durationMs: number;
};

/** restic --json prints one object per line; the last summary is the result. */
export const parseBackupOutput = (output: string): SnapshotSummary | null => {
	let summary: SnapshotSummary | null = null;
	for (const line of output.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.message_type !== "summary") continue;
			summary = {
				snapshotId: String(parsed.snapshot_id ?? ""),
				bytesAdded: Number(parsed.data_added ?? 0),
				bytesProcessed: Number(parsed.total_bytes_processed ?? 0),
				durationMs: Math.round(Number(parsed.total_duration ?? 0) * 1000),
			};
		} catch {
			// Not JSON, e.g. a warning line.
		}
	}
	return summary;
};

export const parseSnapshots = (output: string) => {
	try {
		const parsed = JSON.parse(output) as {
			id: string;
			short_id?: string;
			time: string;
			tags?: string[];
		}[];
		return parsed.map((snapshot) => ({
			id: snapshot.id,
			shortId: snapshot.short_id ?? snapshot.id.slice(0, 8),
			time: snapshot.time,
			tags: snapshot.tags ?? [],
		}));
	} catch {
		return [];
	}
};
