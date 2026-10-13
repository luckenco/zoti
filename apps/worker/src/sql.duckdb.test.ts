import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { insertRecords, type SqlValue } from "./sql"

const knownId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const secondId = "11111111-1111-4111-8111-111111111111"

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

const literal = (value: SqlValue): string => {
  if (value === null) return "NULL"
  if (typeof value !== "string") return `[${value.map((item) => quote(item)).join(", ")}]`
  return quote(value)
}

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../duckdb/migrations/001_records.sql"),
  "utf8",
)

describe("records sql on duckdb", () => {
  it("keeps one row per id", () => {
    const batch = insertRecords("herodotus", [
      {
        id: knownId,
        kind: "video",
        via: "chrome",
        actor: "human",
        agent: null,
        url: "https://www.youtube.com/watch?v=abc",
        title: "it's a talk",
        author: "A channel",
        site: "youtube.com",
        published_at: "2026-10-01T00:00:00.000Z",
        about_id: null,
        text: "",
        tags: ["o'reilly"],
        ts: "2026-10-13T10:52:00.000Z",
        raw: '{"n":1}',
      },
      {
        id: secondId,
        kind: "note",
        via: "cli",
        actor: "agent",
        agent: "pi",
        url: null,
        title: null,
        author: null,
        site: null,
        published_at: null,
        about_id: knownId,
        text: "a note",
        tags: ["etl"],
        ts: "2026-10-13T11:00:00.000Z",
        raw: "{}",
      },
    ])
    const again = insertRecords("herodotus", [
      {
        id: knownId,
        kind: "note",
        via: "cli",
        actor: "agent",
        agent: "pi",
        url: null,
        title: "revised",
        author: null,
        site: null,
        published_at: null,
        about_id: secondId,
        text: "now with text",
        tags: ["reading", "again"],
        ts: "2026-10-13T12:00:00.000Z",
        raw: '{"n":2}',
      },
    ])
    const script = [
      "ATTACH ':memory:' AS herodotus;",
      "USE herodotus;",
      migration,
      `PREPARE batch AS ${batch.text};`,
      `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
      `PREPARE again AS ${again.text};`,
      `EXECUTE again(${again.values.map((value) => literal(value)).join(", ")});`,
      "SELECT id::VARCHAR AS id, kind, via, actor, agent, url, title, author, site, epoch_ms(published_at) AS published_ms, about_id::VARCHAR AS about_id, text, to_json(tags) AS tags, epoch_ms(ts) AS ts_ms, raw, ingested_at IS NOT NULL AS has_ingested FROM herodotus.records ORDER BY id;",
    ].join("\n")
    const result = spawnSync("duckdb", ["-json", ":memory:"], { input: script, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        id: knownId,
        kind: "note",
        via: "cli",
        actor: "agent",
        agent: "pi",
        url: null,
        title: "revised",
        author: null,
        site: null,
        published_ms: null,
        about_id: secondId,
        text: "now with text",
        tags: ["reading", "again"],
        ts_ms: Date.parse("2026-10-13T12:00:00.000Z"),
        raw: '{"n":2}',
        has_ingested: true,
      },
      {
        id: secondId,
        kind: "note",
        via: "cli",
        actor: "agent",
        agent: "pi",
        url: null,
        title: null,
        author: null,
        site: null,
        published_ms: null,
        about_id: knownId,
        text: "a note",
        tags: ["etl"],
        ts_ms: Date.parse("2026-10-13T11:00:00.000Z"),
        raw: "{}",
        has_ingested: true,
      },
    ])
  })
})
