/**
 * Store on PostgreSQL, used when DATABASE_URL is set (docker compose runs one).
 *
 * Same tables as SQLite, with native types: JSONB for configs and reports, TIMESTAMPTZ for dates,
 * BIGINT for counts and seeds (a seed goes up to 2^32 - 1, past INTEGER's range).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import type { Report, Verdict } from '@slottestyfer/simulator/core';
import {
  GameExistsError,
  type SimulationRecord,
  type SimulationStatus,
  type Store,
  type StoredGame,
} from './store.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS games (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    config      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS simulations (
    seq          BIGSERIAL UNIQUE,
    id           TEXT PRIMARY KEY,
    game_id      TEXT NOT NULL REFERENCES games(id),
    spins        BIGINT NOT NULL,
    seed         BIGINT NOT NULL,
    target       DOUBLE PRECISION,
    tolerance    DOUBLE PRECISION NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    rounds_done  BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    report       JSONB,
    verdict      JSONB,
    error        TEXT
  );

  CREATE INDEX IF NOT EXISTS simulations_game ON simulations (game_id, created_at);
  CREATE INDEX IF NOT EXISTS simulations_status ON simulations (status, created_at);
`;

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

function toGame(row: Row): StoredGame {
  return {
    id: String(row['id']),
    name: String(row['name']),
    config: parseGameConfig(row['config']),
    createdAt: iso(row['created_at']),
  };
}

function toSimulation(row: Row): SimulationRecord {
  return {
    id: String(row['id']),
    gameId: String(row['game_id']),
    // BIGINT arrives as a string, so it cannot lose precision; our values fit in a JS number.
    spins: Number(row['spins']),
    seed: Number(row['seed']),
    target: row['target'] === null ? null : Number(row['target']),
    tolerance: Number(row['tolerance']),
    status: String(row['status']) as SimulationStatus,
    roundsDone: Number(row['rounds_done']),
    createdAt: iso(row['created_at']),
    startedAt: isoOrNull(row['started_at']),
    finishedAt: isoOrNull(row['finished_at']),
    report: (row['report'] ?? null) as Report | null,
    verdict: (row['verdict'] ?? null) as Verdict | null,
    error: row['error'] === null || row['error'] === undefined ? null : String(row['error']),
  };
}

export interface PostgresStoreOptions {
  /** postgres://user:password@host:5432/database */
  readonly connectionString: string;
  /**
   * Schema to use (created if missing). Tests use a fresh one each run and drop it on close.
   * Default: public.
   */
  readonly schema?: string;
  readonly dropSchemaOnClose?: boolean;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

export async function createPostgresStore(options: PostgresStoreOptions): Promise<Store> {
  const schema = options.schema ?? 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name "${schema}"`);
  const now = () => (options.now ?? (() => new Date()))().toISOString();

  const pool = new pg.Pool({ connectionString: options.connectionString, max: 5 });
  pool.on('connect', (client) => {
    void client.query(`SET search_path TO ${schema}`);
  });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`SET search_path TO ${schema}; ${SCHEMA}`);

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await pool.query(sql, params)).rows as Row[];

  const getSimulation = async (id: string): Promise<SimulationRecord | undefined> => {
    const [row] = await rows('SELECT * FROM simulations WHERE id = $1', [id]);
    return row ? toSimulation(row) : undefined;
  };

  return {
    kind: 'postgres',

    listGames: async () => (await rows('SELECT * FROM games ORDER BY id')).map(toGame),

    async getGame(id) {
      const [row] = await rows('SELECT * FROM games WHERE id = $1', [id]);
      return row ? toGame(row) : undefined;
    },

    async addGame(config: GameConfig) {
      const createdAt = now();
      try {
        await pool.query(
          'INSERT INTO games (id, name, config, created_at) VALUES ($1, $2, $3, $4)',
          [config.id, config.name, JSON.stringify(config), createdAt],
        );
      } catch (error) {
        // 23505: unique_violation
        if ((error as { code?: string }).code === '23505') throw new GameExistsError(config.id);
        throw error;
      }
      return { id: config.id, name: config.name, config, createdAt };
    },

    async createSimulation(input) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO simulations (id, game_id, spins, seed, target, tolerance, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)`,
        [id, input.gameId, input.spins, input.seed, input.target, input.tolerance, now()],
      );
      const created = await getSimulation(id);
      if (!created) throw new Error(`simulation ${id} was not saved`);
      return created;
    },

    getSimulation,

    async listSimulations(filter = {}) {
      const limit = filter.limit ?? 50;
      const result =
        filter.gameId === undefined
          ? await rows('SELECT * FROM simulations ORDER BY created_at DESC, seq DESC LIMIT $1', [
              limit,
            ])
          : await rows(
              'SELECT * FROM simulations WHERE game_id = $1 ORDER BY created_at DESC, seq DESC LIMIT $2',
              [filter.gameId, limit],
            );
      return result.map(toSimulation);
    },

    listSimulationsByStatus: async (status) =>
      (
        await rows('SELECT * FROM simulations WHERE status = $1 ORDER BY created_at, seq', [status])
      ).map(toSimulation),

    async markRunning(id) {
      await pool.query(
        "UPDATE simulations SET status = 'running', started_at = $1, rounds_done = 0 WHERE id = $2",
        [now(), id],
      );
    },

    async updateProgress(id, roundsDone) {
      await pool.query(
        "UPDATE simulations SET rounds_done = $1 WHERE id = $2 AND status = 'running'",
        [roundsDone, id],
      );
    },

    async markDone(id, report, verdict) {
      await pool.query(
        `UPDATE simulations
         SET status = 'done', finished_at = $1, rounds_done = spins, report = $2, verdict = $3
         WHERE id = $4`,
        [now(), JSON.stringify(report), verdict === null ? null : JSON.stringify(verdict), id],
      );
    },

    async markFailed(id, error) {
      await pool.query(
        "UPDATE simulations SET status = 'failed', finished_at = $1, error = $2 WHERE id = $3",
        [now(), error, id],
      );
    },

    async close() {
      if (options.dropSchemaOnClose && schema !== 'public') {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      }
      await pool.end();
    },
  };
}
