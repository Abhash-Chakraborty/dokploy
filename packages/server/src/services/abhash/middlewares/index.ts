import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { stringify } from "yaml";
import { IS_CLOUD, paths } from "../../../constants";
import { db } from "../../../db";
import {
	abhashTraefikMiddleware,
	applications,
	environments,
	projects,
	server,
} from "../../../db/schema";
import { writeFileRemote } from "../../../utils/process/execAsync";
import { manageDomain } from "../../../utils/traefik/domain";
import { applyDashboardMiddlewares } from "../../../utils/traefik/web-server";
import { findApplicationById } from "../../application";
import { renderMiddleware, traefikName } from "./refs";

export * from "./refs";

export interface PublishReport {
	servers: Array<{ name: string; ok: boolean; error?: string }>;
	routes: { updated: number; failed: string[] };
}

const fileName = (organizationId: string) =>
	`${traefikName(organizationId, "middlewares")}.yml`;

/**
 * Writes the organization's middleware definitions to every server it uses,
 * then re-renders the routers that pick them up. Definitions go first: a
 * router naming a middleware Traefik has not loaded yet is disabled, and a
 * deleted middleware stays defined as a no-op, so there is never a moment
 * where a live router points at nothing.
 */
export const publishMiddlewares = async (
	organizationId: string,
): Promise<PublishReport> => {
	const rows = await db.query.abhashTraefikMiddleware.findMany({
		where: eq(abhashTraefikMiddleware.organizationId, organizationId),
	});
	const content = stringify(
		{
			http: {
				middlewares: Object.fromEntries(
					rows.map((row) => [
						traefikName(row.organizationId, row.name),
						renderMiddleware(row),
					]),
				),
			},
		},
		// Deleted ones share the no-op object; keep each written out in full.
		{ aliasDuplicateObjects: false },
	);

	const report: PublishReport = {
		servers: [],
		routes: { updated: 0, failed: [] },
	};

	if (!IS_CLOUD) {
		try {
			const { DYNAMIC_TRAEFIK_PATH } = paths();
			fs.mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
			fs.writeFileSync(
				path.join(DYNAMIC_TRAEFIK_PATH, fileName(organizationId)),
				content,
				"utf8",
			);
			report.servers.push({ name: "Dokploy server", ok: true });
		} catch (error) {
			report.servers.push({
				name: "Dokploy server",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const remote = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		columns: { serverId: true, name: true, serverStatus: true },
	});
	for (const row of remote) {
		if (row.serverStatus !== "active") continue;
		try {
			const { DYNAMIC_TRAEFIK_PATH } = paths(true);
			await writeFileRemote(
				row.serverId,
				path.join(DYNAMIC_TRAEFIK_PATH, fileName(organizationId)),
				content,
			);
			report.servers.push({ name: row.name, ok: true });
		} catch (error) {
			report.servers.push({
				name: row.name,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Application routers are files Dokploy writes, so they update now.
	// Compose routers are labels and pick changes up on their next deploy.
	const appIds = await db
		.select({ applicationId: applications.applicationId })
		.from(applications)
		.innerJoin(
			environments,
			eq(environments.environmentId, applications.environmentId),
		)
		.innerJoin(projects, eq(projects.projectId, environments.projectId))
		.where(eq(projects.organizationId, organizationId));
	for (const { applicationId } of appIds) {
		const app = await findApplicationById(applicationId).catch(() => null);
		if (!app) continue;
		for (const domain of app.domains) {
			try {
				await manageDomain(app, domain);
				report.routes.updated++;
			} catch {
				report.routes.failed.push(domain.host);
			}
		}
	}

	if (!IS_CLOUD) {
		await applyDashboardMiddlewares().catch(() => null);
	}
	return report;
};

export const listMiddlewares = (organizationId: string) =>
	db.query.abhashTraefikMiddleware.findMany({
		where: eq(abhashTraefikMiddleware.organizationId, organizationId),
		orderBy: (row, { asc }) => [asc(row.createdAt)],
	});

/** Only used to validate project scopes against the organization. */
export const projectIdsIn = async (organizationId: string, ids: string[]) =>
	ids.length === 0
		? []
		: (
				await db.query.projects.findMany({
					where: inArray(projects.projectId, ids),
					columns: { projectId: true, organizationId: true },
				})
			)
				.filter((project) => project.organizationId === organizationId)
				.map((project) => project.projectId);
