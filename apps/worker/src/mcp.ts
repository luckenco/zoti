import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { createMcpHandler } from "agents/mcp/server"
import { Effect, Layer } from "effect"
import type { Identity } from "./auth"
import type { WorkerBindings } from "./bindings"
import { idLayer, type IdSource } from "./handler"
import {
  addItem,
  addItemDescription,
  addItemInput,
  markConsumedDescription,
  markConsumedInput,
  markConsumedItems,
  recentItems,
  recentItemsDescription,
  recentItemsInput,
  searchItems,
  searchItemsDescription,
  searchItemsInput,
} from "./mcp-tools"
import { ItemStore, motherDuckLayer } from "./motherduck"

const createServer = (env: WorkerBindings, identity: Identity | null): McpServer => {
  const server = new McpServer({ name: "herodotus", version: "0.1.0" })
  if (identity === null) return server
  const layer = Layer.mergeAll(
    motherDuckLayer({
      host: env.MOTHERDUCK_HOST,
      database: env.MOTHERDUCK_DATABASE,
      token: env.MOTHERDUCK_TOKEN,
    }),
    idLayer,
  )
  const run = (effect: Effect.Effect<CallToolResult, never, ItemStore | IdSource>): Promise<CallToolResult> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  server.registerTool(
    "add_item",
    { description: addItemDescription, inputSchema: addItemInput },
    (args) => run(addItem(args, identity)),
  )
  server.registerTool(
    "search_items",
    { description: searchItemsDescription, inputSchema: searchItemsInput },
    (args) => run(searchItems(args)),
  )
  server.registerTool(
    "recent_items",
    { description: recentItemsDescription, inputSchema: recentItemsInput },
    (args) => run(recentItems(args)),
  )
  server.registerTool(
    "mark_consumed",
    { description: markConsumedDescription, inputSchema: markConsumedInput },
    (args) => run(markConsumedItems(args)),
  )
  return server
}

export const mcpResponse = (
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext,
  identity: Identity | null,
): Promise<Response> =>
  createMcpHandler(() => createServer(env, identity), { route: "/mcp" })(request, env, ctx)
