/**
 * MCP server tool registry and execution for the dashboard API.
 *
 * Walks the oRPC router at module load time to build a tool list from all
 * non-internal procedures. Tool execution uses createRouterClient so the full
 * middleware chain (withAuth, withOrganization, requirePermission) runs in-process
 * against a synthetic Request carrying the caller's x-api-key header.
 */
import { createRouterClient, isProcedure, type AnyRouter } from "@orpc/server";
import { toJSONSchema } from "zod";
import { router } from "./orpc/router";
import type { ProcedureMeta } from "./orpc/root";
import { serverEnv } from "./serverenv";

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	path: string[];
}

type OrpcInternals = {
	route?: { tags?: string[]; summary?: string; description?: string };
	meta?: ProcedureMeta;
	inputSchema?: Parameters<typeof toJSONSchema>[0];
};

function buildToolList(
	routerObj: AnyRouter,
	prefix: string[] = [],
): McpTool[] {
	const tools: McpTool[] = [];

	for (const [key, value] of Object.entries(routerObj as Record<string, unknown>)) {
		const path = [...prefix, key];

		if (isProcedure(value)) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const orpc = (value as any)["~orpc"] as OrpcInternals;
			const tags = orpc.route?.tags ?? [];
			// Skip .internal-tagged procedures outside development (matches openapi.json behaviour)
			if (tags.includes(".internal") && Bun.env.NODE_ENV !== "development") continue;
			// Skip procedures explicitly opted out of MCP via meta({ mcp: false })
			if (orpc.meta?.mcp === false) continue;

			const inputSchema: Record<string, unknown> = orpc.inputSchema
				? (toJSONSchema(orpc.inputSchema, {
						unrepresentable: "any",
						override({ zodSchema, jsonSchema }) {
							// Map z.date() to { type: "string", format: "date-time" } so callers
							// know to pass ISO 8601 strings rather than getting an opaque {} schema.
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							if ((zodSchema as any)._zod?.def?.type === "date") {
								Object.assign(jsonSchema, { type: "string", format: "date-time" });
							}
						},
					}) as Record<string, unknown>)
				: { type: "object", properties: {} };

			tools.push({
				name: path.join("_"),
				description: orpc.route?.summary ?? orpc.route?.description ?? path.join(" "),
				inputSchema,
				path,
			});
		} else if (typeof value === "object" && value !== null) {
			tools.push(...buildToolList(value as AnyRouter, path));
		}
	}

	return tools;
}

/** All MCP tools derived from the oRPC router. Built once at module load. */
export const mcpTools: McpTool[] = buildToolList(router);

/**
 * Call a named MCP tool with the given arguments, authenticating as the provided
 * dashboard API key. The full oRPC middleware chain runs in-process.
 */
export async function callMcpTool(
	toolName: string,
	args: unknown,
	apiKey: string,
): Promise<unknown> {
	const tool = mcpTools.find((t) => t.name === toolName);
	if (!tool) throw new Error(`Unknown tool: ${toolName}`);

	// The auth middleware reads x-api-key from context.request.headers.
	// A minimal synthetic Request with that header is sufficient.
	const syntheticRequest = new Request(`${serverEnv.ORIGIN}/rpc/${tool.path.join("/")}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(args ?? {}),
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const routerClient = createRouterClient(router as any, {
		context: { request: syntheticRequest } as App.Locals,
	}) as any;

	// Navigate the router client proxy by path at runtime
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let fn = routerClient as any;
	for (const segment of tool.path) {
		fn = fn[segment] as typeof fn;
	}

	return await fn(args);
}
