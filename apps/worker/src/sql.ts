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

export type SqlValue = string | number | null | ReadonlyArray<string>

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

const databaseName = (database: string): string => {
  const name = identifier(database)
  if (name === undefined) throw new Error("database is not an identifier")
  return name
}

export const defaultReadLimit = 20
export const maxReadLimit = 100

export interface RecordSearch {
  readonly text: string | null
  readonly tag: string | null
  readonly via: string | null
  readonly kind: string | null
  readonly from: string | null
  readonly to: string | null
  readonly limit: number
}

const selectedColumns = [
  "id::VARCHAR AS id",
  "kind",
  "via",
  "actor",
  "agent",
  "url",
  "title",
  "author",
  "site",
  "published_at",
  "about_id::VARCHAR AS about_id",
  "text",
  "to_json(tags) AS tags",
  "ts",
].join(", ")

const absent = (value: string | null): string | null => (value === null || value.length === 0 ? null : value)

const limitValue = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxReadLimit) {
    throw new Error("limit must be an integer from 1 to 100")
  }
  return limit
}

export const searchRecords = (database: string, query: RecordSearch): SqlStatement => ({
  text: [
    `SELECT ${selectedColumns}`,
    `FROM ${databaseName(database)}.records`,
    "WHERE ($1 IS NULL OR contains(lower(text), lower($1)))",
    "AND ($2 IS NULL OR list_contains(tags, $2))",
    "AND ($3 IS NULL OR via = $3)",
    "AND ($4 IS NULL OR kind = $4)",
    "AND ($5 IS NULL OR ts >= CAST($5 AS TIMESTAMPTZ))",
    "AND ($6 IS NULL OR ts <= CAST($6 AS TIMESTAMPTZ))",
    "ORDER BY ts DESC",
    "LIMIT $7",
  ].join(" "),
  values: [
    absent(query.text),
    absent(query.tag),
    absent(query.via),
    absent(query.kind),
    absent(query.from),
    absent(query.to),
    limitValue(query.limit),
  ],
})

export const recentRecords = (database: string, limit: number): SqlStatement => ({
  text: `SELECT ${selectedColumns} FROM ${databaseName(database)}.records ORDER BY ts DESC LIMIT $1`,
  values: [limitValue(limit)],
})

export const insertRecords = (database: string, rows: ReadonlyArray<SettledRow>): SqlStatement => {
  const name = databaseName(database)
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
