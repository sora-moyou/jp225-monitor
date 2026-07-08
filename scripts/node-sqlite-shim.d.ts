// Minimal ambient declaration for node:sqlite (real impl exists in Node 22.5+/24).
// @types/node 20.x (this repo) ships no typings for it, so we declare the slice we use.
declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }
  export class DatabaseSync {
    constructor(path: string, opts?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
