import { describe, expect, it, vi } from "vitest";
import { TOOLS, TOOLS_BY_NAME } from "../../server/mcp/tools";

describe("mcp tool registry", () => {
	it("exposes every tool by name", () => {
		expect(TOOLS_BY_NAME.size).toBe(TOOLS.length);
		for (const tool of TOOLS) {
			expect(TOOLS_BY_NAME.get(tool.name)).toBe(tool);
		}
	});

	it("gives every tool a description an agent can act on", () => {
		for (const tool of TOOLS) {
			expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(tool.description.length).toBeGreaterThan(30);
			expect(tool.inputSchema.type).toBe("object");
		}
	});

	it("declares required inputs for every documented required field", () => {
		for (const tool of TOOLS) {
			for (const name of tool.inputSchema.required ?? []) {
				expect(tool.inputSchema.properties).toHaveProperty(name);
			}
		}
	});

	it("rejects a missing required argument before touching the caller", async () => {
		const listServices = TOOLS_BY_NAME.get("list_services");
		expect(listServices).toBeDefined();
		const caller = { environment: { one: vi.fn() } };
		await expect(listServices?.run(caller as never, {})).rejects.toThrow(
			/environmentId/,
		);
		expect(caller.environment.one).not.toHaveBeenCalled();
	});

	it("flattens an environment into one typed service list", async () => {
		const listServices = TOOLS_BY_NAME.get("list_services");
		const caller = {
			environment: {
				one: vi.fn().mockResolvedValue({
					applications: [
						{
							applicationId: "app-1",
							name: "web",
							appName: "web-abc",
							applicationStatus: "done",
							serverId: null,
						},
					],
					compose: [
						{
							composeId: "cmp-1",
							name: "stack",
							appName: "stack-abc",
							composeStatus: "idle",
							serverId: "srv-1",
						},
					],
					postgres: [
						{
							postgresId: "pg-1",
							name: "db",
							appName: "db-abc",
							applicationStatus: "running",
						},
					],
				}),
			},
		};

		const result = (await listServices?.run(caller as never, {
			environmentId: "env-1",
		})) as Record<string, unknown>[];

		expect(caller.environment.one).toHaveBeenCalledWith({
			environmentId: "env-1",
		});
		expect(result).toHaveLength(3);
		expect(result[0]).toMatchObject({
			type: "application",
			id: "app-1",
			status: "done",
		});
		expect(result[1]).toMatchObject({
			type: "compose",
			id: "cmp-1",
			serverId: "srv-1",
		});
		expect(result[2]).toMatchObject({ type: "postgres", id: "pg-1" });
	});

	it("defaults a missing status to idle rather than dropping the service", async () => {
		const listServices = TOOLS_BY_NAME.get("list_services");
		const caller = {
			environment: {
				one: vi.fn().mockResolvedValue({
					applications: [{ applicationId: "a", name: "x", appName: "x" }],
				}),
			},
		};
		const result = (await listServices?.run(caller as never, {
			environmentId: "env-1",
		})) as Record<string, unknown>[];
		expect(result[0]?.status).toBe("idle");
	});

	it("routes list_deployments to the compose procedure for compose ids", async () => {
		const listDeployments = TOOLS_BY_NAME.get("list_deployments");
		const caller = {
			deployment: {
				all: vi.fn().mockResolvedValue([]),
				allByCompose: vi.fn().mockResolvedValue([]),
			},
		};

		await listDeployments?.run(caller as never, {
			id: "cmp-1",
			type: "compose",
		});
		expect(caller.deployment.allByCompose).toHaveBeenCalledWith({
			composeId: "cmp-1",
		});
		expect(caller.deployment.all).not.toHaveBeenCalled();

		await listDeployments?.run(caller as never, {
			id: "app-1",
			type: "application",
		});
		expect(caller.deployment.all).toHaveBeenCalledWith({
			applicationId: "app-1",
		});
	});
});
