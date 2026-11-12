import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { createMcpHandler } from "agents/mcp/server"
import { Effect } from "effect"
import type { Identity } from "./auth"
import type { WorkerBindings } from "./bindings"
import {
  addToZoteroCollection,
  addToZoteroCollectionDescription,
  addToZoteroCollectionInput,
  listZoteroCollections,
  listZoteroCollectionsDescription,
  listZoteroCollectionsInput,
  searchZotero,
  searchZoteroDescription,
  searchZoteroInput,
  sendToZotero,
  sendToZoteroDescription,
  sendToZoteroInput,
} from "./mcp-tools"
import { Zotero, zoteroLayer } from "./zotero"

const createServer = (env: WorkerBindings, identity: Identity | null): McpServer => {
  const server = new McpServer({ name: "zoti", version: "0.1.0" })
  if (identity === null) return server
  const layer = zoteroLayer({ apiKey: env.ZOTERO_API_KEY, userId: env.ZOTERO_USER_ID })
  const run = (effect: Effect.Effect<CallToolResult, never, Zotero>): Promise<CallToolResult> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  server.registerTool(
    "send_to_zotero",
    { description: sendToZoteroDescription, inputSchema: sendToZoteroInput },
    (args) => run(sendToZotero(args)),
  )
  server.registerTool(
    "search_zotero",
    { description: searchZoteroDescription, inputSchema: searchZoteroInput },
    (args) => run(searchZotero(args)),
  )
  server.registerTool(
    "list_zotero_collections",
    { description: listZoteroCollectionsDescription, inputSchema: listZoteroCollectionsInput },
    (args) => run(listZoteroCollections(args)),
  )
  server.registerTool(
    "add_to_zotero_collection",
    { description: addToZoteroCollectionDescription, inputSchema: addToZoteroCollectionInput },
    (args) => run(addToZoteroCollection(args)),
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
