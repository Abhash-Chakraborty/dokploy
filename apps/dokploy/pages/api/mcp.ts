import { validateRequest } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { appRouter } from "@/server/api/root";
import { TOOLS, TOOLS_BY_NAME } from "@/server/mcp/tools";

/**
 * Model Context Protocol endpoint.
 *
 * Speaks JSON-RPC 2.0 over a single POST, which is all the streamable-HTTP
 * transport needs for a stateless read-only tool server. Implemented directly
 * rather than through the MCP SDK so the fork doesn't take a new runtime
 * dependency for it.
 *
 * Authentication reuses validateRequest, so an `x-api-key` header (a Dokploy
 * API key) or a session cookie both work, and tools run through the same tRPC
 * caller as the dashboard — an agent gets exactly the permissions of the key
 * it presented, never more.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "dokploy", version: "1.0.0" };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
}

const ok = (id: JsonRpcId, result: unknown) => ({
	jsonrpc: "2.0" as const,
	id,
	result,
});

const fail = (id: JsonRpcId, code: number, message: string) => ({
	jsonrpc: "2.0" as const,
	id,
	error: { code, message },
});

/** MCP returns tool failures as content with isError, not as protocol errors. */
const toolFailure = (message: string) => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

const handleMessage = async (
	message: JsonRpcRequest,
	caller: ReturnType<typeof appRouter.createCaller>,
) => {
	const id = message.id ?? null;

	switch (message.method) {
		case "initialize":
			return ok(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions:
					"Read-only access to this Dokploy instance. Call list_projects first to discover projects and environments, then list_services for what runs in one. fleet_overview reports the health of every server at once.",
			});

		case "notifications/initialized":
		case "notifications/cancelled":
			// Notifications carry no id and expect no response.
			return null;

		case "ping":
			return ok(id, {});

		case "tools/list":
			return ok(id, {
				tools: TOOLS.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			});

		case "tools/call": {
			const name = message.params?.name;
			if (typeof name !== "string") {
				return fail(id, -32602, "`name` is required");
			}
			const tool = TOOLS_BY_NAME.get(name);
			if (!tool) {
				return fail(id, -32602, `Unknown tool: ${name}`);
			}

			const args =
				(message.params?.arguments as Record<string, unknown> | undefined) ??
				{};

			try {
				const result = await tool.run(caller, args);
				return ok(id, {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					isError: false,
				});
			} catch (error) {
				return ok(
					id,
					toolFailure(
						error instanceof Error
							? error.message
							: "The tool failed with an unknown error.",
					),
				);
			}
		}

		default:
			return fail(id, -32601, `Method not found: ${message.method}`);
	}
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		res.status(405).json({ message: "Use POST for MCP requests." });
		return;
	}

	const { session, user } = await validateRequest(req);
	if (!user || !session) {
		res
			.status(401)
			.json({ message: "Unauthorized. Send a Dokploy API key as x-api-key." });
		return;
	}

	const caller = appRouter.createCaller({
		req: req as never,
		res: res as never,
		db: null as never,
		session: {
			...session,
			activeOrganizationId: session.activeOrganizationId || "",
		} as never,
		user: user as never,
	});

	const body = req.body as JsonRpcRequest | JsonRpcRequest[];

	if (Array.isArray(body)) {
		const responses = (
			await Promise.all(body.map((entry) => handleMessage(entry, caller)))
		).filter(Boolean);
		// An all-notification batch gets no body, per JSON-RPC.
		if (responses.length === 0) {
			res.status(202).end();
			return;
		}
		res.status(200).json(responses);
		return;
	}

	const response = await handleMessage(body ?? {}, caller);
	if (!response) {
		res.status(202).end();
		return;
	}
	res.status(200).json(response);
};

export default handler;
