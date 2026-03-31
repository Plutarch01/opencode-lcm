declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, opts?: { create: boolean });
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      run(...args: unknown[]): void;
      get(...args: unknown[]): Record<string, unknown>;
      all(...args: unknown[]): Record<string, unknown>[];
      values(...args: unknown[]): unknown[][];
    };
    query(sql: string): {
      run(...args: unknown[]): void;
      get(...args: unknown[]): Record<string, unknown>;
      all(...args: unknown[]): Record<string, unknown>[];
    };
  }
}
