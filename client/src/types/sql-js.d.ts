declare module 'sql.js' {
  declare class Database {
    constructor(data?: Uint8Array);
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }
  declare class Statement {
    run(params?: unknown[]): void;
    free(): void;
  }
  interface SqlJsStatic { Database: typeof Database; }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
