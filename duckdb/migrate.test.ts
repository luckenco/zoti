import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"
import {
  listMigrationsSql,
  loadMigrations,
  recordMigrationSql,
  runMigrations,
  schemaMigrationsSql,
  splitSql,
  type MigrationFile,
  type QueryClient,
} from "./migrate"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations")

class MemoryClient implements QueryClient {
  readonly calls: Array<{ text: string; values?: ReadonlyArray<unknown> }> = []
  readonly recorded: Array<string> = []
  mode: "transaction" | "no-transaction" | "ddl-outside" | "begin-fails" = "transaction"
  failSql: string | null = null
  private depth = 0
  private aborted = false

  async query(text: string, values?: ReadonlyArray<unknown>) {
    this.calls.push({ text, values })
    if (this.aborted && text !== "ROLLBACK") throw new Error("current transaction is aborted")
    if (text === "BEGIN") {
      if (this.mode === "no-transaction") throw new Error("Not implemented Error: BEGIN is not supported")
      if (this.mode === "begin-fails") throw new Error("connection reset")
      this.depth += 1
      return { rows: [] }
    }
    if (text === "ROLLBACK") {
      this.depth = 0
      this.aborted = false
      return { rows: [] }
    }
    if (text === "COMMIT") {
      if (this.depth === 0) throw new Error("no transaction")
      this.depth = 0
      return { rows: [] }
    }
    if (text === listMigrationsSql) return { rows: this.recorded.map((filename) => ({ filename })) }
    if (text === recordMigrationSql) {
      const filename = values?.[0]
      if (typeof filename !== "string" || filename.length === 0) throw new Error("filename missing")
      if (this.recorded.includes(filename)) throw new Error("duplicate key")
      this.recorded.push(filename)
      return { rows: [] }
    }
    if (this.mode === "ddl-outside" && this.depth > 0 && /^(create|alter)\b/i.test(text.trim())) {
      this.aborted = true
      throw new Error("Not implemented Error: DDL in a transaction is not supported")
    }
    if (this.failSql !== null && text.includes(this.failSql)) {
      if (this.depth > 0) this.aborted = true
      throw new Error(`syntax error in ${text}`)
    }
    return { rows: [] }
  }
}

const lastJson = (stdout: string): unknown => {
  const values: Array<unknown> = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (char === undefined) break
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

describe("splitSql", () => {
  it("splits statements and ignores comments", () => {
    assert.deepEqual(splitSql("-- leading;\nCREATE TABLE a (id INT); /* semi; */\nINSERT INTO a VALUES (1);"), [
      "CREATE TABLE a (id INT)",
      "INSERT INTO a VALUES (1)",
    ])
    assert.deepEqual(splitSql("SELECT 'a;b', 'it''s', $tag$ x; y $tag$;"), ["SELECT 'a;b', 'it''s', $tag$ x; y $tag$"])
    assert.deepEqual(splitSql("-- only a comment\n"), [])
  })

  it("rejects an unfinished quote", () => {
    assert.throws(() => splitSql("SELECT 'open"), /unterminated string/)
    assert.throws(() => splitSql("SELECT $tag$ open"), /unterminated dollar quote/)
    assert.throws(() => splitSql("SELECT 1 /*"), /unterminated block comment/)
  })
})

describe("runMigrations", () => {
  const checkedIn = (): ReadonlyArray<MigrationFile> => loadMigrations(migrationsDir)

  it("applies checked-in files once, in order, inside a transaction", async () => {
    const files = checkedIn()
    assert.deepEqual(
      files.map((file) => file.filename),
      ["001_records.sql", "002_consumed_at.sql", "003_zotero.sql"],
    )
    const first = splitSql(files[0]?.sql ?? "")
    const second = splitSql(files[1]?.sql ?? "")
    const third = splitSql(files[2]?.sql ?? "")
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(third.length, 2)
    assert.match(first[0] ?? "", /^CREATE TABLE IF NOT EXISTS records\b/)
    assert.match(second[0] ?? "", /^ALTER TABLE records ADD COLUMN IF NOT EXISTS consumed_at\b/)
    assert.match(third[0] ?? "", /^ALTER TABLE records ADD COLUMN IF NOT EXISTS zotero_key\b/)
    assert.match(third[1] ?? "", /^ALTER TABLE records ADD COLUMN IF NOT EXISTS zotero_url\b/)

    const client = new MemoryClient()
    const logged: Array<string> = []
    const applied = await runMigrations(client, [...files].reverse(), (message) => {
      logged.push(message)
    })
    assert.deepEqual(applied, ["001_records.sql", "002_consumed_at.sql", "003_zotero.sql"])
    assert.deepEqual(logged, [
      "applied 001_records.sql",
      "applied 002_consumed_at.sql",
      "applied 003_zotero.sql",
    ])
    assert.deepEqual(
      client.calls.map((call) => call.text),
      [
        schemaMigrationsSql,
        listMigrationsSql,
        "BEGIN",
        first[0],
        recordMigrationSql,
        "COMMIT",
        "BEGIN",
        second[0],
        recordMigrationSql,
        "COMMIT",
        "BEGIN",
        third[0],
        third[1],
        recordMigrationSql,
        "COMMIT",
      ],
    )
    assert.deepEqual(client.calls[4]?.values, ["001_records.sql"])
    assert.deepEqual(client.calls[8]?.values, ["002_consumed_at.sql"])
    assert.deepEqual(client.calls[13]?.values, ["003_zotero.sql"])

    const before = client.calls.length
    const again = await runMigrations(client, files)
    assert.deepEqual(again, [])
    assert.deepEqual(
      client.calls.slice(before).map((call) => call.text),
      [schemaMigrationsSql, listMigrationsSql],
    )
  })

  it("skips recorded files and stops after a failure", async () => {
    const client = new MemoryClient()
    client.recorded.push("001_a.sql")
    client.failSql = "boom"
    const files = [
      { filename: "010_c.sql", sql: "CREATE TABLE c (id INT)" },
      { filename: "002_b.sql", sql: "ALTER TABLE a ADD COLUMN boom INT" },
      { filename: "001_a.sql", sql: "CREATE TABLE a (id INT)" },
    ]
    await assert.rejects(() => runMigrations(client, files), /migration 002_b.sql failed: syntax error/)
    assert.deepEqual(client.recorded, ["001_a.sql"])
    assert.equal(client.calls.filter((call) => call.text === "ROLLBACK").length, 1)
    assert.equal(client.calls.filter((call) => call.text.includes("boom")).length, 1)
    assert.equal(client.calls.filter((call) => call.text.includes("CREATE TABLE c")).length, 0)
  })

  it("runs without a transaction when the server rejects one", async () => {
    const client = new MemoryClient()
    client.mode = "no-transaction"
    const applied = await runMigrations(client, [
      { filename: "001_a.sql", sql: "CREATE TABLE a (id INT); INSERT INTO a VALUES (1);" },
    ])
    assert.deepEqual(applied, ["001_a.sql"])
    assert.equal(client.calls.filter((call) => call.text === "BEGIN").length, 1)
    assert.equal(client.calls.filter((call) => call.text === "COMMIT").length, 0)
    assert.equal(client.calls.filter((call) => call.text === "ROLLBACK").length, 0)
    assert.deepEqual(client.recorded, ["001_a.sql"])
  })

  it("retries a file outside a transaction when DDL cannot run inside one", async () => {
    const client = new MemoryClient()
    client.mode = "ddl-outside"
    const applied = await runMigrations(client, [
      { filename: "001_a.sql", sql: "CREATE TABLE a (id INT)" },
      { filename: "002_b.sql", sql: "ALTER TABLE a ADD COLUMN n INT" },
    ])
    assert.deepEqual(applied, ["001_a.sql", "002_b.sql"])
    assert.equal(client.calls.filter((call) => call.text === "BEGIN").length, 1)
    assert.equal(client.calls.filter((call) => call.text === "ROLLBACK").length, 1)
    assert.equal(client.calls.filter((call) => call.text.startsWith("CREATE TABLE a")).length, 2)
    assert.equal(client.calls.filter((call) => call.text.startsWith("ALTER TABLE a")).length, 1)
  })

  it("names the file when its SQL cannot be applied", async () => {
    const client = new MemoryClient()
    await assert.rejects(
      () => runMigrations(client, [{ filename: "003_bad.sql", sql: "SELECT 'open" }]),
      /migration 003_bad.sql failed: unterminated string/,
    )
    await assert.rejects(
      () => runMigrations(client, [{ filename: "004_empty.sql", sql: "-- nothing\n" }]),
      /migration 004_empty.sql failed: migration has no statements/,
    )
    assert.deepEqual(client.recorded, [])
  })

  it("does not record a file when opening a transaction fails", async () => {
    const client = new MemoryClient()
    client.mode = "begin-fails"
    await assert.rejects(
      () => runMigrations(client, [{ filename: "001_a.sql", sql: "CREATE TABLE a (id INT)" }]),
      /migration 001_a.sql failed: connection reset/,
    )
    assert.deepEqual(client.recorded, [])
    assert.equal(client.calls.filter((call) => call.text.startsWith("CREATE TABLE a")).length, 0)
  })
})

describe("checked-in migrations on duckdb", () => {
  it("re-runs 001, 002, and 003 inside transactions and records them", () => {
    const files = loadMigrations(migrationsDir)
    const first = splitSql(files[0]?.sql ?? "")
    const second = splitSql(files[1]?.sql ?? "")
    const third = splitSql(files[2]?.sql ?? "")
    const script = [
      ...first,
      ...second,
      ...third,
      schemaMigrationsSql,
      `PREPARE record AS ${recordMigrationSql}`,
      "BEGIN",
      ...first,
      "EXECUTE record('001_records.sql')",
      "COMMIT",
      "BEGIN",
      ...second,
      "EXECUTE record('002_consumed_at.sql')",
      "COMMIT",
      "BEGIN",
      ...third,
      "EXECUTE record('003_zotero.sql')",
      "COMMIT",
      "SELECT filename FROM schema_migrations ORDER BY filename",
    ].join(";\n")
    const result = spawnSync("duckdb", ["-json", ":memory:"], { input: `${script};`, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(lastJson(result.stdout), [
      { filename: "001_records.sql" },
      { filename: "002_consumed_at.sql" },
      { filename: "003_zotero.sql" },
    ])
  })
})
