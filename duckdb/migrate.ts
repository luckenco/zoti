import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface QueryClient {
  readonly query: (
    text: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ readonly rows?: ReadonlyArray<Record<string, unknown>> }>
}

export interface MigrationFile {
  readonly filename: string
  readonly sql: string
}

export const schemaMigrationsSql = [
  "CREATE TABLE IF NOT EXISTS schema_migrations (",
  "  filename VARCHAR PRIMARY KEY,",
  "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()",
  ")",
].join("\n")

export const listMigrationsSql = "SELECT filename FROM schema_migrations"

export const recordMigrationSql =
  "INSERT INTO schema_migrations (filename, applied_at) VALUES ($1::VARCHAR, now())"

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "migration failed"
}

const transactionUnsupported = (error: unknown): boolean => {
  const message = messageOf(error)
  if (!/not supported|unsupported|not implemented/i.test(message)) return false
  return /transaction|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(message)
}

const pushStatement = (statements: Array<string>, current: string): void => {
  const statement = current.trim()
  if (statement.length > 0) statements.push(statement)
}

export const splitSql = (sql: string): ReadonlyArray<string> => {
  const source = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql
  const statements: Array<string> = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let dollar: string | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (char === undefined) break
    if (dollar !== null) {
      if (source.startsWith(dollar, index)) {
        current += dollar
        index += dollar.length - 1
        dollar = null
        continue
      }
      current += char
      continue
    }
    if (quote === null && char === "-" && next === "-") {
      const newline = source.indexOf("\n", index)
      index = newline === -1 ? source.length : newline
      continue
    }
    if (quote === null && char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end === -1) throw new Error("unterminated block comment")
      index = end + 1
      continue
    }
    if (quote === "'" && char === "'" && next === "'") {
      current += "''"
      index += 1
      continue
    }
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === null ? char : null
      current += char
      continue
    }
    if (quote === null && char === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(source.slice(index))
      if (match !== null) {
        dollar = match[0]
        current += dollar
        index += dollar.length - 1
        continue
      }
    }
    if (quote === null && char === ";") {
      pushStatement(statements, current)
      current = ""
      continue
    }
    current += char
  }
  if (quote !== null) throw new Error("unterminated string")
  if (dollar !== null) throw new Error("unterminated dollar quote")
  pushStatement(statements, current)
  return statements
}

const byFilename = (left: MigrationFile, right: MigrationFile): number =>
  left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0

const filenamesOf = (rows: ReadonlyArray<Record<string, unknown>> | undefined): ReadonlyArray<string> => {
  if (rows === undefined) return []
  return rows.map((row) => {
    const filename = row.filename
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error("schema_migrations.filename is missing")
    }
    return filename
  })
}

const failure = (filename: string, error: unknown): Error => {
  const message = messageOf(error)
  const prefix = `migration ${filename} failed: `
  if (message.startsWith(prefix)) return error instanceof Error ? error : new Error(message)
  return new Error(`${prefix}${message}`)
}

const applyPlain = async (
  client: QueryClient,
  file: MigrationFile,
  statements: ReadonlyArray<string>,
): Promise<void> => {
  for (const statement of statements) {
    try {
      await client.query(statement)
    } catch (error) {
      throw failure(file.filename, error)
    }
  }
  try {
    await client.query(recordMigrationSql, [file.filename])
  } catch (error) {
    throw failure(file.filename, error)
  }
}

const statementsOf = (file: MigrationFile): ReadonlyArray<string> => {
  try {
    const statements = splitSql(file.sql)
    if (statements.length === 0) throw new Error("migration has no statements")
    return statements
  } catch (error) {
    throw failure(file.filename, error)
  }
}

const applyFile = async (client: QueryClient, file: MigrationFile, transactions: boolean): Promise<boolean> => {
  const statements = statementsOf(file)
  if (!transactions) {
    await applyPlain(client, file, statements)
    return false
  }
  try {
    await client.query("BEGIN")
  } catch (error) {
    if (!transactionUnsupported(error)) throw failure(file.filename, error)
    await applyPlain(client, file, statements)
    return false
  }
  try {
    for (const statement of statements) await client.query(statement)
    await client.query(recordMigrationSql, [file.filename])
    await client.query("COMMIT")
    return true
  } catch (error) {
    const rolledBack = await client.query("ROLLBACK").then(
      () => true,
      () => false,
    )
    if (rolledBack && transactionUnsupported(error)) {
      await applyPlain(client, file, statements)
      return false
    }
    throw failure(file.filename, error)
  }
}

export const loadMigrations = (directory: string): ReadonlyArray<MigrationFile> =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      filename,
      sql: readFileSync(join(directory, filename), "utf8"),
    }))

export const runMigrations = async (
  client: QueryClient,
  files: ReadonlyArray<MigrationFile>,
  log: (message: string) => void = () => undefined,
): Promise<ReadonlyArray<string>> => {
  await client.query(schemaMigrationsSql)
  const existing = await client.query(listMigrationsSql)
  const applied = new Set(filenamesOf(existing.rows))
  const pending = [...files].sort(byFilename).filter((file) => !applied.has(file.filename))
  const done: Array<string> = []
  let transactions = true
  for (const file of pending) {
    transactions = await applyFile(client, file, transactions)
    done.push(file.filename)
    log(`applied ${file.filename}`)
  }
  return done
}

interface PgClient extends QueryClient {
  readonly connect: () => Promise<void>
  readonly end: () => Promise<void>
}

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} is empty`)
  return value
}

const redact = (message: string, token: string): string => {
  if (token.length === 0) return message
  const encoded = encodeURIComponent(token)
  return message.split(token).join("[redacted]").split(encoded).join("[redacted]")
}

const connect = async (host: string, database: string, token: string): Promise<PgClient> => {
  const { Client } = await import("pg")
  const client = new Client({
    host,
    port: 5432,
    user: "postgres",
    password: token,
    database,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  })
  await client.connect()
  return client
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations")

const run = async (): Promise<void> => {
  let token = ""
  let client: PgClient | undefined
  try {
    const host = required("MOTHERDUCK_HOST")
    const database = required("MOTHERDUCK_DATABASE")
    token = required("MOTHERDUCK_TOKEN")
    const files = loadMigrations(migrationsDirectory)
    client = await connect(host, database, token)
    const applied = await runMigrations(client, files, (message) => {
      console.log(message)
    })
    if (applied.length === 0) console.log("migrations up to date")
  } catch (error) {
    console.error(redact(messageOf(error), token))
    process.exitCode = 1
  } finally {
    await client?.end().catch(() => undefined)
  }
}

if (import.meta.main) void run()
