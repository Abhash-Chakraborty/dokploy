import { jsonSchema, type ToolSet, tool } from "ai";
import type { appRouter } from "@/server/api/root";
import { type McpTool, TOOLS } from "./tools";

type Caller = ReturnType<(typeof appRouter)["createCaller"]>;

/**
 * The in-app assistant's tools: the same registry the MCP endpoint serves,
 * run through a tRPC caller built from the signed-in user's own session, so
 * the assistant can see and do exactly what that user can and nothing more.
 *
 * Read-only tools run as the model calls them. Anything that changes state is
 * never executed by the model: the call is recorded as a proposal, and only
 * runs when the user confirms it in the panel.
 */

/**
 * A caller acting as the signed-in user. Built lazily: the root router imports
 * the AI router that uses this, so importing it at module load is a cycle, and
 * the explicit return type keeps that cycle out of the AI router's types.
 */
export const callerFor = async (ctx: unknown): Promise<Caller> => {
	const { appRouter } = await import("@/server/api/root");
	return appRouter.createCaller(ctx as never);
};

export interface AssistantReply {
	reply: string;
	actions: ProposedAction[];
	tools: ToolTrace[];
	durationMs: number;
}

export const isReadOnly = (candidate: McpTool) =>
	candidate.annotations?.readOnlyHint === true;

// Tool results go back into the model's context; a whole fleet's worth of
// JSON would crowd out the conversation and slow every step down.
const MAX_RESULT_CHARS = 12_000;

export const clip = (value: unknown) => {
	const text = JSON.stringify(value) ?? "null";
	return text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)} … (truncated, ask for something narrower)`
		: text;
};

const describeAction = (name: string, args: Record<string, unknown>) => {
	const title = name.replaceAll("_", " ");
	const details = Object.entries(args)
		.map(
			([key, value]) =>
				`${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
		)
		.join(", ");
	return details
		? `${title[0]?.toUpperCase()}${title.slice(1)} · ${details}`
		: `${title[0]?.toUpperCase()}${title.slice(1)}`;
};

export interface ProposedAction {
	tool: string;
	args: Record<string, unknown>;
	summary: string;
	destructive: boolean;
}

export interface ToolTrace {
	tool: string;
	ms: number;
	ok: boolean;
}

export const buildAssistantTools = (
	caller: Caller,
	mode: "read" | "write" | "debug",
	proposals: ProposedAction[],
	trace: ToolTrace[],
): ToolSet => {
	const tools: ToolSet = {};
	for (const entry of TOOLS) {
		const readOnly = isReadOnly(entry);
		if (!readOnly && mode === "read") continue;
		tools[entry.name] = tool({
			description: readOnly
				? entry.description
				: `${entry.description} This is not executed when you call it: it is shown to the user as a proposal to confirm, so explain what it will do.`,
			inputSchema: jsonSchema<Record<string, unknown>>(
				entry.inputSchema as Parameters<typeof jsonSchema>[0],
			),
			execute: async (args: Record<string, unknown>) => {
				const started = Date.now();
				if (!readOnly) {
					proposals.push({
						tool: entry.name,
						args,
						summary: describeAction(entry.name, args),
						destructive: entry.annotations?.destructiveHint === true,
					});
					trace.push({ tool: entry.name, ms: 0, ok: true });
					return {
						status: "awaiting_confirmation",
						note: "Not run yet. The user confirms it in the assistant panel.",
					};
				}
				try {
					const result = await entry.run(caller, args);
					trace.push({ tool: entry.name, ms: Date.now() - started, ok: true });
					return clip(result);
				} catch (error) {
					trace.push({ tool: entry.name, ms: Date.now() - started, ok: false });
					return `Error: ${error instanceof Error ? error.message : String(error)}`;
				}
			},
		});
	}
	return tools;
};
