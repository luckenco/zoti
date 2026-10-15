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
  searchZotero,
  searchZoteroDescription,
  searchZoteroInput,
  sendToZotero,
  sendToZoteroDescription,
  sendToZoteroInput,
} from "./mcp-tools"
import { ItemStore, motherDuckLayer } from "./motherduck"
import { Zotero, zoteroLayer } from "./zotero"

const createServer = (env: WorkerBindings, identity: Identity | null): McpServer => {
  const server = new McpServer({ name: "herodotus", version: "0.1.0" })
  if (identity === null) return server
  const store = Layer.mergeAll(
    motherDuckLayer({
      host: env.MOTHERDUCK_HOST,
      database: env.MOTHERDUCK_DATABASE,
      token: env.MOTHERDUCK_TOKEN,
    }),
    idLayer,
  )
  const layer = zoteroLayer({
    apiKey: env.ZOTERO_API_KEY,
    userId: env.ZOTERO_USER_ID,
  }).pipe(Layer.provideMerge(store))
  const run = (
    effect: Effect.Effect<CallToolResult, never, ItemStore | IdSource | Zotero>,
  ): Promise<CallToolResult> => Effect.runPromise(effect.pipe(Effect.provide(layer)))
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
  server.registerTool(
    "send_to_zotero",
    { description: sendToZoteroDescription, inputSchema: sendToZoteroInput },
    (args) => run(sendToZotero(args, identity)),
  )
  server.registerTool(
    "search_zotero",
    { description: searchZoteroDescription, inputSchema: searchZoteroInput },
    (args) => run(searchZotero(args)),
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
