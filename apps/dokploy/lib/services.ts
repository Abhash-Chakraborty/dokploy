import type { RouterOutputs } from "@/utils/api";

/** Shape returned by project.allForPermissions (admin only). Used for the permissions UI. */
type ProjectForPermissions =
	RouterOutputs["project"]["allForPermissions"][number];
type EnvironmentForPermissions = ProjectForPermissions["environments"][number];

type Environment = EnvironmentForPermissions;

export type Services = {
	appName: string;
	serverId?: string | null;
	name: string;
	type:
		| "mariadb"
		| "application"
		| "postgres"
		| "mysql"
		| "mongo"
		| "redis"
		| "compose"
		| "libsql";
	description?: string | null;
	id: string;
	createdAt: string;
	status?: "idle" | "running" | "done" | "error";
};

export const extractServices = (data: Environment | undefined) => {
	const applications: Services[] = (data?.applications?.map((item) => ({
		appName: item.appName,
		name: item.name,
		type: "application",
		id: item.applicationId,
		createdAt: item.createdAt,
		status: item.applicationStatus,
		description: item.description,
		serverId: item.serverId,
	})) ?? []) as Services[];

	const mariadb: Services[] =
		data?.mariadb.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mariadb",
			id: item.mariadbId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const postgres: Services[] =
		data?.postgres.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "postgres",
			id: item.postgresId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const mongo: Services[] =
		data?.mongo.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mongo",
			id: item.mongoId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const redis: Services[] =
		data?.redis.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "redis",
			id: item.redisId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const mysql: Services[] =
		data?.mysql.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mysql",
			id: item.mysqlId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const compose: Services[] = (data?.compose?.map((item) => ({
		appName: item.appName,
		name: item.name,
		type: "compose",
		id: item.composeId,
		createdAt: item.createdAt,
		status: item.composeStatus,
		description: item.description,
		serverId: item.serverId,
	})) ?? []) as Services[];

	const libsql: Services[] =
		data?.libsql?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "libsql" as const,
			id: item.libsqlId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	applications.push(
		...mysql,
		...redis,
		...mongo,
		...postgres,
		...mariadb,
		...compose,
		...libsql,
	);

	applications.sort((a, b) => {
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});

	return applications;
};
