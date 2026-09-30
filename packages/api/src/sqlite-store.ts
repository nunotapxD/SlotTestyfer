/**
 * Store on the SQLite built into Node.js (node:sqlite): no native driver to compile, one file on
 * disk, and ':memory:' for tests. SQLite is synchronous; the methods return promises only to match
 * the Store interface shared with PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';
import { parseGameConfig } from '@slottestyfer/engine';
import type { Report, Verdict } from '@slottestyfer/simulator/core';
import {
  GameExistsError,
  type SimulationRecord,
  type SimulationStatus,
  type Store,
  type StoredGame,
} from './store.js';

// Loaded with require so test runners that do not know the 'node:sqlite' built-in yet still work.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS games (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS simulations (
    id           TEXT PRIMARY KEY,
    game_id      TEXT NOT NULL REFERENCES games(id),
    spins        INTEGER NOT NULL,
    seed         INTEGER NOT NULL,
    target       REAL,
    tolerance    REAL NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    rounds_done  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    report       TEXT,
    verdict      TEXT,
    error        TEXT
  );

  CREATE INDEX IF NOT EXISTS simulations_game ON simulations (game_id, created_at);
  CREATE INDEX IF NOT EXISTS simulations_status ON simulations (status, created_at);
`;

type Row = Record<string, unknown>;

const text = (row: Row, key: string): string => String(row[key]);
const num = (row: Row, key: string): number => Number(row[key]);
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : String(row[key]);

function toGame(row: Row): StoredGame {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    config: parseGameConfig(JSON.parse(text(row, 'config'))),
    createdAt: text(row, 'created_at'),
  };
}

function toSimulation(row: Row): SimulationRecord {
  const report = nullableText(row, 'report');
  const verdict = nullableText(row, 'verdict');
  return {
    id: text(row, 'id'),
    gameId: text(row, 'game_id'),
    spins: num(row, 'spins'),
    seed: num(row, 'seed'),
    target: row['target'] === null ? null : num(row, 'target'),
    tolerance: num(row, 'tolerance'),
    status: text(row, 'status') as SimulationStatus,
    roundsDone: num(row, 'rounds_done'),
    createdAt: text(row, 'created_at'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at'),
    report: report === null ? null : (JSON.parse(report) as Report),
    verdict: verdict === null ? null : (JSON.parse(verdict) as Verdict),
    error: nullableText(row, 'error'),
  };
}

export interface SqliteStoreOptions {
  /** File path, or ':memory:' for a throwaway database. */
  readonly path: string;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

export function createSqliteStore(options: SqliteStoreOptions): Store {
  const db = new DatabaseSync(options.path);
  const now = () => (options.now ?? (() => new Date()))().toISOString();

  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    listGames: db.prepare('SELECT * FROM games ORDER BY id'),
    getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
    addGame: db.prepare('INSERT INTO games (id, name, config, created_at) VALUES (?, ?, ?, ?)'),
    createSimulation: db.prepare(
      `INSERT INTO simulations (id, game_id, spins, seed, target, tolerance, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ),
    getSimulation: db.prepare('SELECT * FROM simulations WHERE id = ?'),
    listSimulations: db.prepare(
      'SELECT * FROM simulations ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ),
    listSimulationsForGame: db.prepare(
      'SELECT * FROM simulations WHERE game_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ),
    listByStatus: db.prepare(
      'SELECT * FROM simulations WHERE status = ? ORDER BY created_at, rowid',
    ),
    markRunning: db.prepare(
      "UPDATE simulations SET status = 'running', started_at = ?, rounds_done = 0 WHERE id = ?",
    ),
    updateProgress: db.prepare(
      "UPDATE simulations SET rounds_done = ? WHERE id = ? AND status = 'running'",
    ),
    markDone: db.prepare(
      `UPDATE simulations
       SET status = 'done', finished_at = ?, rounds_done = spins, report = ?, verdict = ?
       WHERE id = ?`,
    ),
    markFailed: db.prepare(
      "UPDATE simulations SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
    ),
  };

  const getSimulation = (id: string): SimulationRecord | undefined => {
    const row = q.getSimulation.get(id) as Row | undefined;
    return row ? toSimulation(row) : undefined;
  };

  return {
    kind: 'sqlite',

    listGames: async () => (q.listGames.all() as Row[]).map(toGame),

    async getGame(id) {
      const row = q.getGame.get(id) as Row | undefined;
      return row ? toGame(row) : undefined;
    },

    async addGame(config) {
      if (q.getGame.get(config.id)) throw new GameExistsError(config.id);
      const createdAt = now();
      q.addGame.run(config.id, config.name, JSON.stringify(config), createdAt);
      return { id: config.id, name: config.name, config, createdAt };
    },

    async createSimulation(input) {
      const id = randomUUID();
      q.createSimulation.run(
        id,
        input.gameId,
        input.spins,
        input.seed,
        input.target,
        input.tolerance,
        now(),
      );
      const created = getSimulation(id);
      if (!created) throw new Error(`simulation ${id} was not saved`);
      return created;
    },

    getSimulation: async (id) => getSimulation(id),

    async listSimulations(filter = {}) {
      const limit = filter.limit ?? 50;
      const rows =
        filter.gameId === undefined
          ? q.listSimulations.all(limit)
          : q.listSimulationsForGame.all(filter.gameId, limit);
      return (rows as Row[]).map(toSimulation);
    },

    listSimulationsByStatus: async (status) =>
      (q.listByStatus.all(status) as Row[]).map(toSimulation),

    async markRunning(id) {
      q.markRunning.run(now(), id);
    },

    async updateProgress(id, roundsDone) {
      q.updateProgress.run(roundsDone, id);
    },

    async markDone(id, report, verdict) {
      q.markDone.run(
        now(),
        JSON.stringify(report),
        verdict === null ? null : JSON.stringify(verdict),
        id,
      );
    },

    async markFailed(id, error) {
      q.markFailed.run(now(), error, id);
    },

    async close() {
      db.close();
    },
  };
}
