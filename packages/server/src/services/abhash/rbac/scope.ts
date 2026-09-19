import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashRoleBinding,
	abhashTeam,
	abhashTeamMember,
	environments as environmentTable,
	gitProvider,
	projects as projectTable,
	server,
} from "../../../db/schema";
import type { BindingScope } from "../../../db/schema/abhash-rbac";

export type ScopeRef = { type: BindingScope; id: string };

export type Binding = {
	role: string;
	scopeType: BindingScope;
	scopeId: string;
	inherit: boolean;
	subjectType: "user" | "team";
	subjectId: string;
};

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

/** Bindings that apply to a user in an organization: their own and their teams'. */
export const bindingsFor = async (
	userId: string,
	organizationId: string,
): Promise<Binding[]> => {
	const teams = await db
		.select({ id: abhashTeam.id })
		.from(abhashTeamMember)
		.innerJoin(abhashTeam, eq(abhashTeam.id, abhashTeamMember.teamId))
		.where(
			and(
				eq(abhashTeamMember.userId, userId),
				eq(abhashTeam.organizationId, organizationId),
			),
		);
	const teamIds = [...new Set(teams.map((t) => t.id))];
	const rows = await db.query.abhashRoleBinding.findMany({
		where: and(
			eq(abhashRoleBinding.organizationId, organizationId),
			teamIds.length
				? sql`(${abhashRoleBinding.subjectType} = 'user' AND ${abhashRoleBinding.subjectId} = ${userId}) OR (${abhashRoleBinding.subjectType} = 'team' AND ${inArray(abhashRoleBinding.subjectId, teamIds)})`
				: and(
						eq(abhashRoleBinding.subjectType, "user"),
						eq(abhashRoleBinding.subjectId, userId),
					),
		),
	});
	return rows.map((r) => ({
		role: r.role,
		scopeType: r.scopeType,
		scopeId: r.scopeId,
		inherit: r.inherit,
		subjectType: r.subjectType,
		subjectId: r.subjectId,
	}));
};

const environmentOfService = async (serviceId: string) => {
	const union = sql.join(
		SERVICE_TABLES.map(
			([table, pk]) =>
				sql`SELECT "environmentId" FROM ${sql.identifier(table)} WHERE ${sql.identifier(pk)} = ${serviceId}`,
		),
		sql` UNION ALL `,
	);
	const result = await db.execute<{ environmentId: string }>(
		sql`${union} LIMIT 1`,
	);
	return result[0]?.environmentId ?? null;
};

const projectOfEnvironment = async (environmentId: string) => {
	const row = await db.query.environments.findFirst({
		where: eq(environmentTable.environmentId, environmentId),
		columns: { projectId: true },
	});
	return row?.projectId ?? null;
};

/**
 * The target followed by its ancestors, nearest first. A service id may be
 * of any service type. The organization is always last.
 */
export const ancestry = async (target: ScopeRef): Promise<ScopeRef[]> => {
	const chain: ScopeRef[] = [target];
	let environmentId: string | null = null;
	if (target.type === "service") {
		environmentId = await environmentOfService(target.id);
		if (environmentId) chain.push({ type: "environment", id: environmentId });
	} else if (target.type === "environment") {
		environmentId = target.id;
	}
	if (environmentId) {
		const projectId = await projectOfEnvironment(environmentId);
		if (projectId) chain.push({ type: "project", id: projectId });
	}
	chain.push({ type: "organization", id: "" });
	return chain;
};

/**
 * Bindings that apply at `chain[0]`: those on the target itself, and those on
 * an ancestor that inherit downwards.
 */
export const applicableBindings = (bindings: Binding[], chain: ScopeRef[]) =>
	bindings.filter((b) =>
		chain.some(
			(ref, depth) =>
				b.scopeType === ref.type &&
				b.scopeId === ref.id &&
				(depth === 0 || b.inherit),
		),
	);

const servicesIn = async (environmentIds: string[]) => {
	if (environmentIds.length === 0) return [];
	const union = sql.join(
		SERVICE_TABLES.map(
			([table, pk]) =>
				sql`SELECT ${sql.identifier(pk)} AS id FROM ${sql.identifier(table)} WHERE "environmentId" IN (${sql.join(
					environmentIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
		),
		sql` UNION ALL `,
	);
	const rows = await db.execute<{ id: string }>(union);
	return rows.map((r) => r.id);
};

export type Visibility = {
	projects: string[];
	environments: string[];
	services: string[];
	servers: string[];
	gitProviders: string[];
};

/**
 * What a set of bindings lets a member see. A binding on a resource shows
 * that resource; one that inherits also shows everything inside it; an
 * organization binding shows every project. `seesAllServers` and
 * `seesAllGitProviders` come from the member's effective permissions.
 */
export const visibilityOf = async (
	bindings: Binding[],
	organizationId: string,
	opts: { seesAllServers: boolean; seesAllGitProviders: boolean },
): Promise<Visibility> => {
	const projects = new Set<string>();
	const environments = new Set<string>();
	const services = new Set<string>();
	const servers = new Set<string>();
	const gitProviders = new Set<string>();
	const inheritedProjects = new Set<string>();
	const inheritedEnvironments = new Set<string>();

	for (const b of bindings) {
		switch (b.scopeType) {
			case "organization": {
				const rows = await db.query.projects.findMany({
					where: eq(projectTable.organizationId, organizationId),
					columns: { projectId: true },
				});
				for (const r of rows) {
					projects.add(r.projectId);
					if (b.inherit) inheritedProjects.add(r.projectId);
				}
				break;
			}
			case "project":
				projects.add(b.scopeId);
				if (b.inherit) inheritedProjects.add(b.scopeId);
				break;
			case "environment":
				environments.add(b.scopeId);
				if (b.inherit) inheritedEnvironments.add(b.scopeId);
				break;
			case "service":
				services.add(b.scopeId);
				break;
			case "server":
				servers.add(b.scopeId);
				break;
			case "gitProvider":
				gitProviders.add(b.scopeId);
				break;
		}
	}

	if (inheritedProjects.size > 0) {
		const rows = await db.query.environments.findMany({
			where: inArray(environmentTable.projectId, [...inheritedProjects]),
			columns: { environmentId: true },
		});
		for (const r of rows) {
			environments.add(r.environmentId);
			inheritedEnvironments.add(r.environmentId);
		}
	}
	for (const id of await servicesIn([...inheritedEnvironments])) {
		services.add(id);
	}

	if (opts.seesAllServers) {
		const rows = await db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			columns: { serverId: true },
		});
		for (const r of rows) servers.add(r.serverId);
	}
	if (opts.seesAllGitProviders) {
		const rows = await db.query.gitProvider.findMany({
			where: eq(gitProvider.organizationId, organizationId),
			columns: { gitProviderId: true },
		});
		for (const r of rows) gitProviders.add(r.gitProviderId);
	}

	return {
		projects: [...projects],
		environments: [...environments],
		services: [...services],
		servers: [...servers],
		gitProviders: [...gitProviders],
	};
};
