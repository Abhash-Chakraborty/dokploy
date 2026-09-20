import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
	server,
} from "../../db/schema";

/**
 * Ids arrive from the client, and an id is not a permission: an admin of one
 * organization could otherwise name a server or a database that belongs to
 * another. Everything here answers "not found" rather than "not yours", so
 * it does not confirm that the id exists.
 */
export const assertServerInOrganization = async (
	organizationId: string,
	serverId: string | null | undefined,
) => {
	// Null is the Dokploy host itself, which every organization on it shares.
	if (!serverId) return;
	const row = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
		),
		columns: { serverId: true },
	});
	if (!row) throw new Error("Server not found");
};

export type OwnedServiceKind =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis";

const ownerOf = {
	postgres: (id: string) =>
		db.query.postgres.findFirst({
			where: eq(postgres.postgresId, id),
			columns: { serverId: true },
			with: { environment: { with: { project: true } } },
		}),
	mysql: (id: string) =>
		db.query.mysql.findFirst({
			where: eq(mysql.mysqlId, id),
			columns: { serverId: true },
			with: { environment: { with: { project: true } } },
		}),
	mariadb: (id: string) =>
		db.query.mariadb.findFirst({
			where: eq(mariadb.mariadbId, id),
			columns: { serverId: true },
			with: { environment: { with: { project: true } } },
		}),
	mongo: (id: string) =>
		db.query.mongo.findFirst({
			where: eq(mongo.mongoId, id),
			columns: { serverId: true },
			with: { environment: { with: { project: true } } },
		}),
	redis: (id: string) =>
		db.query.redis.findFirst({
			where: eq(redis.redisId, id),
			columns: { serverId: true },
			with: { environment: { with: { project: true } } },
		}),
} satisfies Record<OwnedServiceKind, (id: string) => Promise<unknown>>;

/** A database service belongs to the organization that owns its project. */
export const assertServiceInOrganization = async (
	organizationId: string,
	kind: OwnedServiceKind,
	serviceId: string,
) => {
	const row = await ownerOf[kind](serviceId);
	if (row?.environment?.project?.organizationId !== organizationId) {
		throw new Error("Service not found");
	}
	return { serverId: row.serverId };
};
