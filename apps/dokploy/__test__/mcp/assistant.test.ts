import { describe, expect, it, vi } from "vitest";
import {
	buildAssistantTools,
	clip,
	isReadOnly,
	type ProposedAction,
	type ToolTrace,
} from "../../server/mcp/assistant";
import { TOOLS, TOOLS_BY_NAME } from "../../server/mcp/tools";

type Executable = {
	execute: (
		args: Record<string, unknown>,
		options: unknown,
	) => Promise<unknown>;
};

const setup = (mode: "read" | "write" | "debug", caller: unknown = {}) => {
	const proposals: ProposedAction[] = [];
	const trace: ToolTrace[] = [];
	const tools = buildAssistantTools(caller as never, mode, proposals, trace);
	return { tools, proposals, trace };
};

describe("assistant tools", () => {
	it("offers only read-only tools in read mode", () => {
		const { tools } = setup("read");
		const offered = Object.keys(tools);
		expect(offered.length).toBeGreaterThan(0);
		for (const name of offered) {
			expect(isReadOnly(TOOLS_BY_NAME.get(name) as never)).toBe(true);
		}
		expect(offered).not.toContain("deploy_application");
	});

	it("offers every tool in write mode", () => {
		const { tools } = setup("write");
		expect(Object.keys(tools).sort()).toEqual(
			TOOLS.map((tool) => tool.name).sort(),
		);
	});

	it("records a mutating call as a proposal without running it", async () => {
		const deploy = vi.fn();
		const { tools, proposals, trace } = setup("write", {
			application: { deploy },
		});
		const result = await (
			tools.deploy_application as unknown as Executable
		).execute({ applicationId: "app-1" }, { toolCallId: "1", messages: [] });
		expect(deploy).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "awaiting_confirmation" });
		expect(proposals).toEqual([
			expect.objectContaining({
				tool: "deploy_application",
				args: { applicationId: "app-1" },
				summary: "Deploy application · applicationId app-1",
			}),
		]);
		expect(trace[0]).toMatchObject({ tool: "deploy_application", ok: true });
	});

	it("runs a read-only tool through the caller and reports failures as text", async () => {
		const all = vi
			.fn()
			.mockResolvedValue([{ projectId: "p1", name: "Shop", environments: [] }]);
		const { tools, trace } = setup("read", { project: { all } });
		const ok = await (tools.list_projects as unknown as Executable).execute(
			{},
			{ toolCallId: "1", messages: [] },
		);
		expect(all).toHaveBeenCalledOnce();
		expect(String(ok)).toContain("Shop");

		all.mockRejectedValueOnce(new Error("FORBIDDEN"));
		const failed = await (tools.list_projects as unknown as Executable).execute(
			{},
			{ toolCallId: "2", messages: [] },
		);
		expect(failed).toBe("Error: FORBIDDEN");
		expect(trace.map((t) => t.ok)).toEqual([true, false]);
	});

	it("clips large results", () => {
		const big = clip({ data: "x".repeat(50_000) });
		expect(big.length).toBeLessThan(13_000);
		expect(big).toContain("truncated");
	});
});
