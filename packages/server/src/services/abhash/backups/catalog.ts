import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashBackupPolicy,
	abhashBackupRepository,
	abhashBackupRun,
	backups,
	deployments,
	destinations,
	volumeBackups,
} from "../../../db/schema";

/**
 * Every backup the organization has, whichever engine runs it: database dumps
 * and volume archives written to an S3 destination, and restic policies. The
 * Backups page lists them together so there is one place to look.
 */
export type BackupJobKind = "dump" | "volume" | "dokploy" | "restic";

export type BackupRunTarget =
	| {
			engine: "dump";
			backupId: string;
			databaseType: string;
			backupType: string;
	  }
	| { engine: "volume"; volumeBackupId: string }
	| { engine: "restic"; policyId: string };

export interface BackupJob {
	id: string;
	kind: BackupJobKind;
	name: string;
	/** What is copied: database name, volume name or path. */
	target: string;
	project: string | null;
	service: string | null;
	href: string | null;
	schedule: string | null;
	enabled: boolean;
	storage: string;
	lastRun: { status: string; at: string; error?: string | null } | null;
	run: BackupRunTarget;
}

const SERVICE_KEYS = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
	"redis",
	"application",
	"compose",
] as const;
type ServiceKey = (typeof SERVICE_KEYS)[number];

type ServiceRow = {
	name: string;
	environmentId: string;
	environment?: { project?: { projectId: string; name: string } | null } | null;
} & Record<string, unknown>;

const serviceWith = {
	columns: { name: true, environmentId: true },
	with: {
		environment: {
			columns: {},
			with: { project: { columns: { projectId: true, name: true } } },
		},
	},
} as const;

const ownerOf = (
	row: Record<string, unknown>,
	tab: (key: ServiceKey) => string,
) => {
	for (const key of SERVICE_KEYS) {
		const service = row[key] as ServiceRow | null | undefined;
		const id = row[`${key}Id`] as string | null | undefined;
		if (service && id) {
			const project = service.environment?.project;
			return {
				service: service.name,
				project: project?.name ?? null,
				href: project
					? `/dashboard/project/${project.projectId}/environment/${service.environmentId}/services/${key}/${id}?tab=${tab(key)}`
					: null,
			};
		}
	}
	return null;
};

export const listBackupJobs = async (
	organizationId: string,
): Promise<BackupJob[]> => {
	const orgDestinations = await db
		.select({ id: destinations.destinationId, name: destinations.name })
		.from(destinations)
		.where(eq(destinations.organizationId, organizationId));
	const destinationIds = orgDestinations.map((row) => row.id);
	const destinationName = new Map(
		orgDestinations.map((row) => [row.id, row.name]),
	);

	const [dumpRows, volumeRows] = destinationIds.length
		? await Promise.all([
				db.query.backups.findMany({
					where: inArray(backups.destinationId, destinationIds),
					with: {
						postgres: serviceWith,
						mysql: serviceWith,
						mariadb: serviceWith,
						mongo: serviceWith,
						libsql: serviceWith,
						compose: serviceWith,
					},
				}),
				db.query.volumeBackups.findMany({
					where: inArray(volumeBackups.destinationId, destinationIds),
					with: {
						application: serviceWith,
						postgres: serviceWith,
						mysql: serviceWith,
						mariadb: serviceWith,
						mongo: serviceWith,
						redis: serviceWith,
						libsql: serviceWith,
						compose: serviceWith,
					},
				}),
			])
		: [[], []];

	const lastDeployments = async (
		column: typeof deployments.backupId | typeof deployments.volumeBackupId,
		ids: string[],
	) => {
		if (ids.length === 0) return new Map<string, BackupJob["lastRun"]>();
		const rows = await db
			.selectDistinctOn([column], {
				owner: column,
				status: deployments.status,
				at: deployments.createdAt,
				error: deployments.errorMessage,
			})
			.from(deployments)
			.where(inArray(column, ids))
			.orderBy(column, desc(deployments.createdAt));
		return new Map(
			rows.map((row) => [
				row.owner ?? "",
				{ status: row.status ?? "done", at: row.at, error: row.error },
			]),
		);
	};

	const [dumpRuns, volumeRuns] = await Promise.all([
		lastDeployments(
			deployments.backupId,
			dumpRows.map((row) => row.backupId),
		),
		lastDeployments(
			deployments.volumeBackupId,
			volumeRows.map((row) => row.volumeBackupId),
		),
	]);

	const jobs: BackupJob[] = [];

	for (const row of dumpRows) {
		const isDokploy = row.databaseType === "web-server";
		const owner = ownerOf(row as Record<string, unknown>, () => "backups");
		jobs.push({
			id: row.backupId,
			kind: isDokploy ? "dokploy" : "dump",
			name: isDokploy
				? "Dokploy itself"
				: row.backupType === "compose"
					? `${row.serviceName ?? row.database}`
					: row.database,
			target: isDokploy ? "Panel database" : row.database,
			project: isDokploy ? "Dokploy" : (owner?.project ?? null),
			service: isDokploy ? null : (owner?.service ?? null),
			href: isDokploy ? null : (owner?.href ?? null),
			schedule: row.schedule,
			enabled: !!row.enabled,
			storage: destinationName.get(row.destinationId) ?? "S3",
			lastRun: dumpRuns.get(row.backupId) ?? null,
			run: {
				engine: "dump",
				backupId: row.backupId,
				databaseType: row.databaseType,
				backupType: row.backupType,
			},
		});
	}

	for (const row of volumeRows) {
		const owner = ownerOf(row as Record<string, unknown>, (key) =>
			key === "compose" ? "backups" : "volume-backups",
		);
		jobs.push({
			id: row.volumeBackupId,
			kind: "volume",
			name: row.name,
			target: row.volumeName,
			project: owner?.project ?? null,
			service: owner?.service ?? null,
			href: owner?.href ?? null,
			schedule: row.cronExpression,
			enabled: !!row.enabled,
			storage: destinationName.get(row.destinationId) ?? "S3",
			lastRun: volumeRuns.get(row.volumeBackupId) ?? null,
			run: { engine: "volume", volumeBackupId: row.volumeBackupId },
		});
	}

	const policies = await db
		.select({
			id: abhashBackupPolicy.id,
			name: abhashBackupPolicy.name,
			target: abhashBackupPolicy.target,
			targetKind: abhashBackupPolicy.targetKind,
			cron: abhashBackupPolicy.cronExpression,
			enabled: abhashBackupPolicy.enabled,
			repository: abhashBackupRepository.name,
		})
		.from(abhashBackupPolicy)
		.innerJoin(
			abhashBackupRepository,
			eq(abhashBackupRepository.id, abhashBackupPolicy.repositoryId),
		)
		.where(eq(abhashBackupPolicy.organizationId, organizationId));

	const resticRuns = policies.length
		? await db
				.selectDistinctOn([abhashBackupRun.policyId], {
					policyId: abhashBackupRun.policyId,
					status: abhashBackupRun.status,
					at: abhashBackupRun.startedAt,
					error: abhashBackupRun.error,
				})
				.from(abhashBackupRun)
				.where(
					and(
						inArray(
							abhashBackupRun.policyId,
							policies.map((policy) => policy.id),
						),
					),
				)
				.orderBy(abhashBackupRun.policyId, desc(abhashBackupRun.startedAt))
		: [];
	const resticLast = new Map(resticRuns.map((run) => [run.policyId, run]));

	for (const policy of policies) {
		const last = resticLast.get(policy.id);
		jobs.push({
			id: policy.id,
			kind: policy.targetKind === "dokploy" ? "dokploy" : "restic",
			name: policy.name,
			target: policy.target,
			project: policy.targetKind === "dokploy" ? "Dokploy" : null,
			service: null,
			href: null,
			schedule: policy.cron,
			enabled: policy.enabled,
			storage: policy.repository,
			lastRun: last
				? {
						status:
							last.status === "succeeded"
								? "done"
								: last.status === "failed"
									? "error"
									: "running",
						at: last.at.toISOString(),
						error: last.error,
					}
				: null,
			run: { engine: "restic", policyId: policy.id },
		});
	}

	return jobs.sort(
		(a, b) =>
			(a.project ?? "~").localeCompare(b.project ?? "~") ||
			a.name.localeCompare(b.name),
	);
};
