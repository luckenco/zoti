declare module "pg" {
  export class Client {
    constructor(config: {
      readonly connectionString: string
      readonly connectionTimeoutMillis?: number
      readonly query_timeout?: number
    })
    connect(): Promise<void>
    query(queryText: string, values?: ReadonlyArray<unknown>): Promise<unknown>
    end(): Promise<void>
  }
}
