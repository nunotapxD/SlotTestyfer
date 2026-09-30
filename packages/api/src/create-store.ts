/**
 * Picks the database from the environment: PostgreSQL when DATABASE_URL is set, otherwise the
 * built-in SQLite at DATABASE_PATH.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSqliteStore } from './sqlite-store.js';
import type { Store } from './store.js';

export interface StoreSettings {
  /** postgres://... Takes precedence over databasePath. */
  readonly databaseUrl?: string | undefined;
  /** SQLite file, or ':memory:'. */
  readonly databasePath: string;
}

export async function createStore(settings: StoreSettings): Promise<Store> {
  if (settings.databaseUrl) {
    // Loaded only when needed, so the SQLite setup never touches the pg driver.
    const { createPostgresStore } = await import('./postgres-store.js');
    return createPostgresStore({ connectionString: settings.databaseUrl });
  }
  if (settings.databasePath !== ':memory:') {
    mkdirSync(dirname(resolve(settings.databasePath)), { recursive: true });
  }
  return createSqliteStore({ path: settings.databasePath });
}
