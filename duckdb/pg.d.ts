declare module "pg" {
  export class Client {
    constructor(config: {
      readonly host: string
      readonly port: number
      readonly user: string
      readonly password: string
      readonly database: string
      readonly ssl?: { readonly rejectUnauthorized?: boolean }
      readonly connectionTimeoutMillis?: number
      readonly query_timeout?: number
    })
    connect(): Promise<void>
    query(
      queryText: string,
      values?: ReadonlyArray<unknown>,
    ): Promise<{ readonly rows?: ReadonlyArray<Record<string, unknown>> }>
    end(): Promise<void>
  }
}
