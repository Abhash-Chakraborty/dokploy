import type { appRouter } from "@/server/api/root";

type Caller = ReturnType<(typeof appRouter)["createCaller"]>;

export interface McpTool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
	run: (caller: Caller, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

const required = (value: unknown, name: string) => {
	const asString = str(value);
	if (!asString)
		throw new Error(`\`${name}\` is required and must be a string`);
	return asString;
};

/**
 * Read-only tools only.
 *
 * Every one goes through the same tRPC caller the dashboard uses, so an agent
 * inherits exactly the permissions of the API key it authenticated with — no
 * parallel authorization path to keep in sync.
 */
export const TOOLS: McpTool[] = [
	{
		name: "list_projects",
		description:
			"List every project in the organization with its environments. Start here to discover what exists before drilling into services.",
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => {
			const projects = await caller.project.all();
			return projects.map((project) => ({
				projectId: project.projectId,
				name: project.name,
				description: project.description,
				createdAt: project.createdAt,
				environments: (project.environments ?? []).map((environment) => ({
					environmentId: environment.environmentId,
					name: environment.name,
				})),
			}));
		},
	},
	{
		name: "list_services",
		description:
			"List the services (applications, compose stacks and databases) in one environment, with their current status. Requires an environmentId from list_projects.",
		inputSchema: {
			type: "object",
			properties: {
				environmentId: {
					type: "string",
					description: "Environment to list services for.",
				},
			},
			required: ["environmentId"],
		},
		run: async (caller, args) => {
			const environmentId = required(args.environmentId, "environmentId");
			const environment = await caller.environment.one({ environmentId });
			const collect = <T extends Record<string, unknown>>(
				items: T[] | undefined,
				type: string,
				idKey: string,
				statusKey: string,
			) =>
				(items ?? []).map((item) => ({
					type,
					id: item[idKey],
					name: item.name,
					appName: item.appName,
					status: item[statusKey] ?? "idle",
					serverId: item.serverId ?? null,
				}));

			return [
				...collect(
					environment.applications,
					"application",
					"applicationId",
					"applicationStatus",
				),
				...collect(
					environment.compose,
					"compose",
					"composeId",
					"composeStatus",
				),
				...collect(
					environment.postgres,
					"postgres",
					"postgresId",
					"applicationStatus",
				),
				...collect(environment.mysql, "mysql", "mysqlId", "applicationStatus"),
				...collect(
					environment.mariadb,
					"mariadb",
					"mariadbId",
					"applicationStatus",
				),
				...collect(environment.mongo, "mongo", "mongoId", "applicationStatus"),
				...collect(environment.redis, "redis", "redisId", "applicationStatus"),
			];
		},
	},
	{
		name: "get_application",
		description:
			"Full detail for one application: build settings, source, domains, environment variables and current status.",
		inputSchema: {
			type: "object",
			properties: {
				applicationId: { type: "string", description: "Application to fetch." },
			},
			required: ["applicationId"],
		},
		run: async (caller, args) =>
			caller.application.one({
				applicationId: required(args.applicationId, "applicationId"),
			}),
	},
	{
		name: "list_deployments",
		description:
			"Recent deployments for an application or compose stack, newest first. Use this to see whether a deploy succeeded and when.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "applicationId or composeId." },
				type: {
					type: "string",
					enum: ["application", "compose"],
					description: "Which kind of service the id refers to.",
				},
			},
			required: ["id", "type"],
		},
		run: async (caller, args) => {
			const id = required(args.id, "id");
			const type = required(args.type, "type");
			if (type === "compose") {
				return caller.deployment.allByCompose({ composeId: id });
			}
			return caller.deployment.all({ applicationId: id });
		},
	},
	{
		name: "fleet_overview",
		description:
			"Health of every server in the organization at once: Docker and Traefik versions, Swarm state, container counts, disk and memory headroom, and any version drift between servers.",
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => caller.server.fleetOverview(),
	},
	{
		name: "host_capabilities",
		description:
			"What a host can currently do — Docker reachable, Swarm active, Traefik managed, config present. Use this to explain why a panel feature is unavailable.",
		inputSchema: {
			type: "object",
			properties: {
				serverId: {
					type: "string",
					description:
						"Remote server to check. Omit for the Dokploy host itself.",
				},
			},
		},
		run: async (caller, args) =>
			caller.settings.getHostCapabilities({ serverId: str(args.serverId) }),
	},
	{
		name: "list_containers",
		description: "Docker containers on a server, with image, state and status.",
		inputSchema: {
			type: "object",
			properties: {
				serverId: {
					type: "string",
					description:
						"Remote server to inspect. Omit for the Dokploy host itself.",
				},
			},
		},
		run: async (caller, args) =>
			caller.docker.getContainers({ serverId: str(args.serverId) }),
	},
	{
		name: "prune_preview",
		description:
			"What a Docker cleanup would reclaim on a host — stopped containers, unused images, unused volumes and build cache — without deleting anything.",
		inputSchema: {
			type: "object",
			properties: {
				serverId: {
					type: "string",
					description:
						"Remote server to check. Omit for the Dokploy host itself.",
				},
			},
		},
		run: async (caller, args) =>
			caller.settings.getPrunePreview({ serverId: str(args.serverId) }),
	},
	{
		name: "list_servers",
		description:
			"Registered remote servers with their connection details and how many services each hosts.",
		inputSchema: { type: "object", properties: {} },
		run: async (caller) => caller.server.all(),
	},
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
