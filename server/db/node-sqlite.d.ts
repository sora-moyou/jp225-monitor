// Minimal ambient declarations for node:sqlite (not yet in @types/node v20).
// Can be removed once package.json upgrades @types/node to >=22.
declare module 'node:sqlite' {
  interface StatementResultingChanges {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }
  class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
