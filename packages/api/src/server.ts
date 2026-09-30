/**
 * Entry point: reads the environment, prepares the database and starts listening.
 *
 * Environment (see .env.example):
 *   PORT            default 3000
 *   HOST            default 0.0.0.0
 *   DATABASE_URL    postgres://... to use PostgreSQL; otherwise SQLite at DATABASE_PATH
 *   DATABASE_PATH   default ./data/slottestyfer.db (':memory:' for a throwaway database)
 *   GAMES_DIR       default ./games, loaded into the database on startup
 *   SIM_WORKERS     worker threads per simulation, default: CPU cores - 1 (at least 1)
 *   MAX_SPINS       largest simulation a request may ask for, default 100000000
 *   MAX_LIVE_RUNS   live runs active at once, default 4
 *   STATIC_DIR      serve the built web page from here, and the API under /api (all in one)
 *   LOG_LEVEL       default info
 */
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { buildApp, DEFAULT_MAX_SPINS } from './app.js';
import { createStore } from './create-store.js';
import { loadGameFiles, seedGames } from './games.js';

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const port = intFromEnv('PORT', 3000, 0);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const databaseUrl = process.env['DATABASE_URL'] || undefined;
  const databasePath = process.env['DATABASE_PATH'] ?? './data/slottestyfer.db';
  const gamesDir = resolve(process.env['GAMES_DIR'] ?? './games');
  const workers = intFromEnv('SIM_WORKERS', Math.max(1, availableParallelism() - 1), 1);
  const maxSpins = intFromEnv('MAX_SPINS', DEFAULT_MAX_SPINS, 1);
  const maxLiveRuns = intFromEnv('MAX_LIVE_RUNS', 4, 1);
  const staticDir = process.env['STATIC_DIR'] ? resolve(process.env['STATIC_DIR']) : undefined;
  const level = process.env['LOG_LEVEL'] ?? 'info';

  const store = await createStore({ databaseUrl, databasePath });
  const added = await seedGames(store, loadGameFiles(gamesDir));

  const { app } = await buildApp({
    store,
    workers,
    maxSpins,
    maxLiveRuns,
    logger: { level },
    ...(staticDir ? { staticDir, apiPrefix: '/api' } : {}),
  });
  app.log.info(
    { database: store.kind, gamesDir, added, workers, staticDir: staticDir ?? null },
    `loaded ${(await store.listGames()).length} games`,
  );

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
