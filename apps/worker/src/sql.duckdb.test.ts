import { describe, it } from "@effect/vitest"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { insertRecords, markConsumed, recentRecords, searchRecords, type SqlStatement, type SqlValue } from "./sql"

const knownId = "0f8fad5b-d9cb-469f-a165-70867728950e"
const secondId = "11111111-1111-4111-8111-111111111111"

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

const literal = (value: SqlValue): string => {
  if (value === null) return "NULL"
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value !== "string") return `[${value.map((item) => quote(item)).join(", ")}]`
  return quote(value)
}

const lastJson = (stdout: string): unknown => {
  const values: Array<unknown> = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < stdout.length; index++) {
    const char = stdout[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "[" || char === "{") {
      if (depth === 0) start = index
      depth += 1
    } else if (char === "]" || char === "}") {
      depth -= 1
      if (depth === 0 && start >= 0) {
        values.push(JSON.parse(stdout.slice(start, index + 1)))
        start = -1
      }
    }
  }
  const last = values.at(-1)
  assert.ok(last)
  return last
}

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../../../duckdb/migrations")
const migration = readFileSync(join(migrationDir, "001_records.sql"), "utf8")
const withConsumed = `${migration}\n${readFileSync(join(migrationDir, "002_consumed_at.sql"), "utf8")}`

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

  it("runs the fixed search and recent statements", () => {
    const passage = {
      id: knownId,
      kind: "video",
      via: "chrome",
      actor: "human",
      agent: null,
      url: null,
      title: null,
      author: null,
      site: null,
      published_at: null,
      about_id: null,
      text: "the selected passage",
      tags: ["reading"],
      ts: "2026-10-13T10:52:00.000Z",
      raw: "{}",
    }
    const other = {
      ...passage,
      id: secondId,
      kind: "note",
      via: "cli",
      text: "other note",
      tags: ["etl"],
      ts: "2026-10-14T10:52:00.000Z",
    }
    const batch = insertRecords("herodotus", [passage, other])
    const run = (statement: SqlStatement) => {
      const name = statement.text.startsWith("SELECT id::VARCHAR AS id, kind, via") ? "read" : "batch"
      const script = [
        "ATTACH ':memory:' AS herodotus;",
        "USE herodotus;",
        withConsumed,
        `PREPARE batch AS ${batch.text};`,
        `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
        `PREPARE ${name} AS ${statement.text};`,
        `EXECUTE ${name}(${statement.values.map((value) => literal(value)).join(", ")});`,
      ].join("\n")
      const result = spawnSync("duckdb", ["-json", ":memory:"], { input: script, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      const stdout = result.stdout.trim()
      return (stdout.length === 0 ? [] : JSON.parse(stdout)) as ReadonlyArray<{ id: string }>
    }
    const ids = (statement: SqlStatement) => run(statement).map((row) => row.id)
    assert.deepEqual(
      ids(searchRecords("herodotus", { text: "PASSAGE", tag: null, via: null, kind: null, from: null, to: null, limit: 100, unread: false })),
      [knownId],
    )
    assert.deepEqual(
      ids(searchRecords("herodotus", { text: null, tag: "reading", via: "chrome", kind: "video", from: null, to: null, limit: 100, unread: false })),
      [knownId],
    )
    assert.deepEqual(
      ids(
        searchRecords("herodotus", {
          text: null,
          tag: null,
          via: null,
          kind: null,
          from: "2026-10-14T00:00:00.000Z",
          to: null,
          limit: 100, unread: false,
        }),
      ),
      [secondId],
    )
    assert.deepEqual(
      ids(searchRecords("herodotus", { text: "", tag: null, via: null, kind: null, from: null, to: null, limit: 1, unread: false })),
      [secondId],
    )
    assert.deepEqual(ids(recentRecords("herodotus", 1)), [secondId])
    const payload = "'; DROP TABLE records; --"
    const injected = searchRecords("herodotus", {
      text: payload,
      tag: null,
      via: null,
      kind: null,
      from: null,
      to: null,
      limit: 20,
      unread: false,
    })
    assert.equal(injected.text.includes(payload), false)
    assert.deepEqual(ids(injected), [])
  })

  it("keeps consumed_at when the same id is upserted", () => {
    const row = {
      id: knownId,
      kind: "note",
      via: "chrome",
      actor: "human",
      agent: null,
      url: null,
      title: null,
      author: null,
      site: null,
      published_at: null,
      about_id: null,
      text: "first",
      tags: ["reading"],
      ts: "2026-10-13T10:52:00.000Z",
      raw: "{}",
    }
    const other = { ...row, id: secondId, text: "second", ts: "2026-10-14T10:52:00.000Z" }
    const batch = insertRecords("herodotus", [row, other])
    const again = insertRecords("herodotus", [{ ...row, text: "revised" }])
    const marked = markConsumed("herodotus", [knownId], true)
    const cleared = markConsumed("herodotus", [knownId], false)
    const unread = searchRecords("herodotus", {
      text: null,
      tag: null,
      via: null,
      kind: null,
      from: null,
      to: null,
      limit: 100,
      unread: true,
    })
    const script = [
      "ATTACH ':memory:' AS herodotus;",
      "USE herodotus;",
      withConsumed,
      withConsumed,
      `PREPARE batch AS ${batch.text};`,
      `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
      `PREPARE mark AS ${marked.text};`,
      `EXECUTE mark(${marked.values.map((value) => literal(value)).join(", ")});`,
      `CREATE TABLE snap AS SELECT epoch_ms(consumed_at) AS consumed_ms FROM herodotus.records WHERE id = '${knownId}';`,
      `PREPARE again AS ${again.text};`,
      `EXECUTE again(${again.values.map((value) => literal(value)).join(", ")});`,
      `SELECT id::VARCHAR AS id, text, consumed_at IS NOT NULL AS marked, epoch_ms(consumed_at) = (SELECT consumed_ms FROM snap) AS kept FROM herodotus.records WHERE id = '${knownId}';`,
    ].join("\n")
    const kept = spawnSync("duckdb", ["-json", ":memory:"], { input: script, encoding: "utf8" })
    assert.equal(kept.status, 0, kept.stderr)
    assert.deepEqual(lastJson(kept.stdout), [{ id: knownId, text: "revised", marked: true, kept: true }])
    const afterClear = [
      "ATTACH ':memory:' AS herodotus;",
      "USE herodotus;",
      withConsumed,
      `PREPARE batch AS ${batch.text};`,
      `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
      `PREPARE mark AS ${marked.text};`,
      `EXECUTE mark(${marked.values.map((value) => literal(value)).join(", ")});`,
      `PREPARE clear AS ${cleared.text};`,
      `EXECUTE clear(${cleared.values.map((value) => literal(value)).join(", ")});`,
      `PREPARE unread AS ${unread.text};`,
      `EXECUTE unread(${unread.values.map((value) => literal(value)).join(", ")});`,
    ].join("\n")
    const result = spawnSync("duckdb", ["-json", ":memory:"], { input: afterClear, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    const rows = lastJson(result.stdout) as ReadonlyArray<{ id: string }>
    assert.deepEqual(
      rows.map((item) => item.id).sort(),
      [knownId, secondId].sort(),
    )
  })

  it("runs the typed search statement MotherDuck prepares", () => {
    const passage = {
      id: knownId,
      kind: "video",
      via: "chrome",
      actor: "human",
      agent: null,
      url: null,
      title: null,
      author: null,
      site: null,
      published_at: null,
      about_id: null,
      text: "the selected passage",
      tags: ["reading"],
      ts: "2026-10-13T10:52:00.000Z",
      raw: "{}",
    }
    const other = {
      ...passage,
      id: secondId,
      kind: "note",
      via: "cli",
      text: "other note",
      tags: ["etl"],
      ts: "2026-10-14T10:52:00.000Z",
    }
    const batch = insertRecords("herodotus", [passage, other])
    const marked = markConsumed("herodotus", [secondId], true)
    const textOnly = searchRecords("herodotus", {
      text: "PASSAGE",
      tag: null,
      via: null,
      kind: null,
      from: null,
      to: null,
      limit: 20,
      unread: false,
    })
    const filtered = searchRecords("herodotus", {
      text: null,
      tag: null,
      via: "chrome",
      kind: null,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-31T00:00:00.000Z",
      limit: 20,
      unread: true,
    })
    for (const statement of [textOnly, filtered]) {
      assert.equal(statement.text.includes("$1 IS NULL"), false)
      assert.equal(statement.text.includes("$1::VARCHAR IS NULL"), true)
      assert.equal(statement.text.includes("$5::TIMESTAMPTZ IS NULL"), true)
      assert.equal(statement.text.includes("NOT $8::BOOLEAN"), true)
      assert.equal(statement.values.includes(null), true)
    }
    const run = (statement: SqlStatement) => {
      const script = [
        "ATTACH ':memory:' AS herodotus;",
        "USE herodotus;",
        withConsumed,
        `PREPARE batch AS ${batch.text};`,
        `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
        `PREPARE mark AS ${marked.text};`,
        `EXECUTE mark(${marked.values.map((value) => literal(value)).join(", ")});`,
        `PREPARE search AS ${statement.text};`,
        `EXECUTE search(${statement.values.map((value) => literal(value)).join(", ")});`,
      ].join("\n")
      const result = spawnSync("duckdb", ["-json", ":memory:"], { input: script, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      const last = lastJson(result.stdout)
      assert.ok(Array.isArray(last))
      return last.map((row) => (row as { id: string }).id)
    }
    assert.deepEqual(run(textOnly), [knownId])
    assert.deepEqual(run(filtered), [knownId])
  })

  it("matches the text filter against title and url", () => {
    const titled = {
      id: knownId,
      kind: "video",
      via: "chrome",
      actor: "human",
      agent: null,
      url: null,
      title: "Quarterly Review",
      author: null,
      site: null,
      published_at: null,
      about_id: null,
      text: "no keywords here",
      tags: ["reading"],
      ts: "2026-10-13T10:52:00.000Z",
      raw: "{}",
    }
    const linked = {
      ...titled,
      id: secondId,
      title: null,
      url: "https://example.com/Alpha",
      text: "",
      ts: "2026-10-14T10:52:00.000Z",
    }
    const plainId = "22222222-2222-4222-8222-222222222222"
    const plain = {
      ...titled,
      id: plainId,
      title: null,
      url: null,
      text: "plain body",
      ts: "2026-10-12T10:52:00.000Z",
    }
    const batch = insertRecords("herodotus", [titled, linked, plain])
    const search = (text: string) =>
      searchRecords("herodotus", {
        text,
        tag: null,
        via: null,
        kind: null,
        from: null,
        to: null,
        limit: 20,
        unread: false,
      })
    const byTitle = search("REVIEW")
    const byUrl = search("alpha")
    const byText = search("PLAIN")
    const missing = search("absent")
    for (const statement of [byTitle, byUrl, byText, missing]) {
      assert.equal(statement.text.includes("$1::VARCHAR IS NULL"), true)
      assert.equal(statement.text.includes("lower($1::VARCHAR)"), true)
      assert.equal(statement.text.includes("$1 IS NULL"), false)
      assert.equal(statement.text.includes("coalesce(title, '')"), true)
      assert.equal(statement.text.includes("coalesce(url, '')"), true)
    }
    const run = (statement: SqlStatement) => {
      const script = [
        "ATTACH ':memory:' AS herodotus;",
        "USE herodotus;",
        withConsumed,
        `PREPARE batch AS ${batch.text};`,
        `EXECUTE batch(${batch.values.map((value) => literal(value)).join(", ")});`,
        `PREPARE search AS ${statement.text};`,
        `EXECUTE search(${statement.values.map((value) => literal(value)).join(", ")});`,
      ].join("\n")
      const result = spawnSync("duckdb", ["-json", ":memory:"], { input: script, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      const stdout = result.stdout.trim()
      if (stdout.length === 0) return []
      const last = lastJson(stdout)
      assert.ok(Array.isArray(last))
      return last.map((row) => (row as { id: string }).id)
    }
    assert.deepEqual(run(byTitle), [knownId])
    assert.deepEqual(run(byUrl), [secondId])
    assert.deepEqual(run(byText), [plainId])
    assert.deepEqual(run(missing), [])
  })
})
