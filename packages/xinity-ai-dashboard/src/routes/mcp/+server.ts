/**
 * MCP (Model Context Protocol) endpoint as a Streamable HTTP transport.
 *
 * Exposes all non-internal dashboard oRPC procedures as MCP tools, authenticated
 * via dashboard API keys (x-api-key header or Authorization: Bearer).
 *
 * Compatible with Claude Desktop, Cursor, and any MCP-capable client.
 *
 * Client configuration:
 *   { "url": "https://dashboard.example.com/mcp", "headers": { "x-api-key": "sk_..." } }
 */
import { json, type RequestHandler } from "@sveltejs/kit";
import { mcpTools, callMcpTool, type McpTool } from "$lib/server/mcp";
import { serverEnv } from "$lib/server/serverenv";

const SERVER_INFO = { name: "xinity-ai", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

function extractApiKey(request: Request): string | null {
	const bearer = request.headers.get("Authorization");
	if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
	return request.headers.get("x-api-key");
}

function toMcpToolDef(tool: McpTool) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: { type: "object", ...tool.inputSchema },
	};
}

type JsonRpcMessage = {
	jsonrpc: string;
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
};

async function handleMessage(
	msg: JsonRpcMessage,
	apiKey: string | null,
): Promise<Record<string, unknown> | null> {
	const { jsonrpc, id, method, params } = msg;

	// Notifications have no id: no response expected
	if (id === undefined && method.startsWith("notifications/")) return null;

	switch (method) {
		case "initialize":
			return {
				jsonrpc,
				id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
				},
			};

		case "tools/list":
			return { jsonrpc, id, result: { tools: mcpTools.map(toMcpToolDef) } };

		case "tools/call": {
			if (!apiKey) {
				return {
					jsonrpc,
					id,
					error: { code: -32001, message: "Unauthorized: missing x-api-key or Authorization header" },
				};
			}
			const name = params?.name as string | undefined;
			const args = params?.arguments;
			if (!name) {
				return { jsonrpc, id, error: { code: -32602, message: "Invalid params: missing name" } };
			}
			try {
				const result = await callMcpTool(name, args, apiKey);
				return {
					jsonrpc,
					id,
					result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
				};
			} catch (err) {
				return {
					jsonrpc,
					id,
					result: {
						content: [{ type: "text", text: String(err) }],
						isError: true,
					},
				};
			}
		}

		default:
			return { jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } };
	}
}

export const POST: RequestHandler = async ({ request }) => {
	if (!serverEnv.MCP_ENABLED) return new Response("Not Found", { status: 404 });
	const apiKey = extractApiKey(request);
	const body = (await request.json()) as JsonRpcMessage | JsonRpcMessage[];
	const messages = Array.isArray(body) ? body : [body];

	const responses = (
		await Promise.all(messages.map((m) => handleMessage(m, apiKey)))
	).filter(Boolean);

	return Array.isArray(body) ? json(responses) : json(responses[0] ?? {});
};
