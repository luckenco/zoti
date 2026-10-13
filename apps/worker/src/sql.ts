export interface SettledRow {
  readonly id: string
  readonly kind: string
  readonly via: string
  readonly actor: string
  readonly agent: string | null
  readonly url: string | null
  readonly title: string | null
  readonly author: string | null
  readonly site: string | null
  readonly published_at: string | null
  readonly about_id: string | null
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly ts: string
  readonly raw: string
}

export type SqlValue = string | null | ReadonlyArray<string>

export interface SqlStatement {
  readonly text: string
  readonly values: ReadonlyArray<SqlValue>
}

const identifierPattern = /^[a-z_][a-z0-9_]*$/

export const identifier = (value: string): string | undefined =>
  identifierPattern.test(value) ? value : undefined

const columns = [
  "id",
  "kind",
  "via",
  "actor",
  "agent",
  "url",
  "title",
  "author",
  "site",
  "published_at",
  "about_id",
  "text",
  "tags",
  "ts",
  "raw",
] as const

const assignments = [
  "kind = EXCLUDED.kind",
  "via = EXCLUDED.via",
  "actor = EXCLUDED.actor",
  "agent = EXCLUDED.agent",
  "url = EXCLUDED.url",
  "title = EXCLUDED.title",
  "author = EXCLUDED.author",
  "site = EXCLUDED.site",
  "published_at = EXCLUDED.published_at",
  "about_id = EXCLUDED.about_id",
  "text = EXCLUDED.text",
  "tags = EXCLUDED.tags",
  "ts = EXCLUDED.ts",
  "raw = EXCLUDED.raw",
  "ingested_at = now()",
] as const

export const insertRecords = (database: string, rows: ReadonlyArray<SettledRow>): SqlStatement => {
  const name = identifier(database)
  if (name === undefined) throw new Error("database is not an identifier")
  const values: Array<SqlValue> = []
  const tuples = rows.map((row) => {
    const start = values.length
    values.push(
      row.id,
      row.kind,
      row.via,
      row.actor,
      row.agent,
      row.url,
      row.title,
      row.author,
      row.site,
      row.published_at,
      row.about_id,
      row.text,
      [...row.tags],
      row.ts,
      row.raw,
    )
    const slots = columns.map((_, column) => `$${start + column + 1}`)
    return `(${slots.join(", ")})`
  })
  return {
    text: `INSERT INTO ${name}.records (${columns.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (id) DO UPDATE SET ${assignments.join(", ")}`,
    values,
  }
}
