import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
	type PermissionCtx,
} from "../permission";

const SERVICE_TABLES = [
	["application", "applicationId"],
	["compose", "composeId"],
	["postgres", "postgresId"],
	["mysql", "mysqlId"],
	["mariadb", "mariadbId"],
	["mongo", "mongoId"],
	["redis", "redisId"],
	["libsql", "libsqlId"],
] as const;

/**
 * The service in `organizationId` that owns a Docker app name. Compose
 * containers are named `<appName>-<service>-<n>`, so the longest matching
 * app-name prefix wins.
 */
export const findServiceByAppName = async (
	appName: string,
	organizationId: string,
): Promise<string | null> => {
	const union = sql.join(
		SERVICE_TABLES.map(
			([table, pk]) => sql`
				SELECT s.${sql.identifier(pk)} AS id, s."appName" AS "appName"
				FROM ${sql.identifier(table)} s
				JOIN "environment" e ON e."environmentId" = s."environmentId"
				JOIN "project" p ON p."projectId" = e."projectId"
				WHERE p."organizationId" = ${organizationId}
					AND (s."appName" = ${appName} OR ${appName} LIKE s."appName" || '-%')`,
		),
		sql` UNION ALL `,
	);
	const rows = await db.execute<{ id: string; appName: string }>(
		sql`SELECT id FROM (${union}) matches ORDER BY length("appName") DESC LIMIT 1`,
	);
	return rows[0]?.id ?? null;
};

/**
 * Guards endpoints that take a raw Docker app name. A name belonging to a
 * service needs the usual scoped access to that service; any other name
 * (Dokploy's own containers, unmanaged ones) is for owners and admins only.
 */
export const assertAppNameAccess = async (
	ctx: PermissionCtx,
	appName: string,
	permissions: Parameters<typeof checkServicePermissionAndAccess>[2],
) => {
	const organizationId = ctx.session.activeOrganizationId;
	const serviceId = await findServiceByAppName(appName, organizationId);
	if (serviceId) {
		await checkServicePermissionAndAccess(ctx, serviceId, permissions);
		return;
	}
	const row = await findMemberByUserId(ctx.user.id, organizationId);
	if (row.role !== "owner" && row.role !== "admin") {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this application",
		});
	}
};
