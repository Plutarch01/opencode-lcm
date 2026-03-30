import type { SqlDatabaseLike } from './store-types.js';

/**
 * Schema version management operations.
 * Handles reading, writing, and validating the SQLite store schema version.
 */

export function readSchemaVersionSync(db: SqlDatabaseLike): number {
  const result = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object') return 0;
  for (const value of Object.values(result)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

export function assertSupportedSchemaVersionSync(db: SqlDatabaseLike, maxVersion: number): void {
  const schemaVersion = readSchemaVersionSync(db);
  if (schemaVersion <= maxVersion) return;
  throw new Error(
    `Unsupported store schema version: ${schemaVersion}. This build supports up to ${maxVersion}.`,
  );
}

export function writeSchemaVersionSync(db: SqlDatabaseLike, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))}`);
}
