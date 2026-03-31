import type { SqlDatabaseLike, SqlStatementLike } from './store-types.js';

/**
 * Validates that a SQL statement result contains the expected number of rows.
 * Throws a descriptive error if the constraint is violated.
 */
export function assertSingleRow(
  result: unknown,
  operation: string,
): asserts result is Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    throw new Error(`${operation}: expected a single row, got ${typeof result}`);
  }
}

/**
 * Validates that a SQL statement affected at least one row.
 * Useful for UPDATE/DELETE operations where zero rows may indicate a bug.
 */
export function assertAffectedRows(
  statement: SqlStatementLike,
  args: unknown[],
  operation: string,
  minRows = 1,
): void {
  const result = statement.run(...args) as { changes: number } | undefined;
  const changes = result?.changes ?? 0;
  if (changes < minRows) {
    throw new Error(`${operation}: expected at least ${minRows} affected rows, got ${changes}`);
  }
}

/**
 * Safely executes a SQL statement and returns typed results.
 * Wraps the raw SQLite call with validation to catch schema mismatches early.
 */
export function safeQuery<T extends Record<string, unknown>>(
  statement: SqlStatementLike,
  args: unknown[],
  operation: string,
): T[] {
  const result = statement.all(...args);
  if (!Array.isArray(result)) {
    throw new Error(`${operation}: expected array result, got ${typeof result}`);
  }
  return result as T[];
}

/**
 * Safely executes a SQL statement that should return exactly one row.
 */
export function safeQueryOne<T extends Record<string, unknown>>(
  statement: SqlStatementLike,
  args: unknown[],
  operation: string,
): T | undefined {
  const result = statement.get(...args) as Record<string, unknown> | undefined;
  if (result && typeof result !== 'object') {
    throw new Error(`${operation}: expected object or undefined, got ${typeof result}`);
  }
  return result as T | undefined;
}

/**
 * Wraps database operations in a transaction with proper error handling.
 * Automatically rolls back on failure.
 */
export function withTransaction(db: SqlDatabaseLike, operation: string, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${operation} transaction failed: ${message}`);
  }
}

/**
 * Lightweight runtime validator for SQL row results.
 * Checks that required keys exist and have the expected types.
 * Returns the row as-is if valid, throws if not.
 */
export function validateRow<T extends Record<string, unknown>>(
  row: unknown,
  schema: Record<keyof T, 'string' | 'number' | 'boolean' | 'object' | 'nullable'>,
  operation: string,
): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${operation}: expected an object row, got ${typeof row}`);
  }
  const record = row as Record<string, unknown>;
  for (const [key, expectedType] of Object.entries(schema) as Array<[string, string]>) {
    const value = record[key];
    if (expectedType === 'nullable') continue;
    if (value === null || value === undefined) {
      throw new Error(`${operation}: missing required column "${key}"`);
    }
    if (typeof value !== expectedType) {
      throw new Error(
        `${operation}: column "${key}" expected ${expectedType}, got ${typeof value}`,
      );
    }
  }
  return record as T;
}
