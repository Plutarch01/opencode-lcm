/**
 * Shared type definitions for the SQLite store layer.
 * These types are used across store.ts, sql-utils.ts, and related modules.
 */

export type SqlStatementLike = {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown;
};

export type SqlDatabaseLike = {
  exec(sql: string): unknown;
  close(): void;
  prepare(sql: string): SqlStatementLike;
};
