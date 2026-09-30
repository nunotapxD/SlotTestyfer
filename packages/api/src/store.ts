/**
 * Persistence for games and simulations, using the SQLite built into Node.js (node:sqlite).
 *
 * No native driver to compile, one file on disk, and ':memory:' for tests. The rest of the API
 * only talks to the {@link Store} interface, so a PostgreSQL implementation can be added later
 * without touching the routes.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import type { Report, Verdict } from '@slottestyfer/simulator';

// Loaded with require so test runners that do not know the 'node:sqlite' built-in yet still work.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;

export type SimulationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface StoredGame {
  readonly id: string;
  readonly name: string;
  readonly config: GameConfig;
  readonly createdAt: string;
}

export interface NewSimulation {
  readonly gameId: string;
  readonly spins: number;
  readonly seed: number;
  /** Target RTP as a fraction (0.96), or null for no verdict. */
  readonly target: number | null;
  /** Allowed deviation as a fraction (0.005 = 0.5 percentage points). */
  readonly tolerance: number;
}

export interface SimulationRecord extends NewSimulation {
  readonly id: string;
  readonly status: SimulationStatus;
  readonly roundsDone: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly report: Report | null;
  readonly verdict: Verdict | null;
  readonly error: string | null;
}

export class GameExistsError extends Error {
  constructor(id: string) {
    super(`a game with id "${id}" already exists`);
    this.name = 'GameExistsError';
  }
}

export interface Store {
  listGames(): StoredGame[];
  getGame(id: string): StoredGame | undefined;
  /** Adds a validated game. Throws GameExistsError if the id is taken. */
  addGame(config: GameConfig): StoredGame;

  createSimulation(input: NewSimulation): SimulationRecord;
  getSimulation(id: string): SimulationRecord | undefined;
  /** Most recent first. */
  listSimulations(filter?: { gameId?: string; limit?: number }): SimulationRecord[];
  /** Oldest first, for the runner's queue. */
  listSimulationsByStatus(status: SimulationStatus): SimulationRecord[];
  markRunning(id: string): void;
  updateProgress(id: string, roundsDone: number): void;
  markDone(id: string, report: Report, verdict: Verdict | null): void;
  markFailed(id: string, error: string): void;

  close(): void;
}

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

  const statements = {
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
    updateProgress: db.prepare('UPDATE simulations SET rounds_done = ? WHERE id = ?'),
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
    const row = statements.getSimulation.get(id) as Row | undefined;
    return row ? toSimulation(row) : undefined;
  };

  return {
    listGames: () => (statements.listGames.all() as Row[]).map(toGame),

    getGame(id) {
      const row = statements.getGame.get(id) as Row | undefined;
      return row ? toGame(row) : undefined;
    },

    addGame(config) {
      if (statements.getGame.get(config.id)) throw new GameExistsError(config.id);
      const createdAt = now();
      statements.addGame.run(config.id, config.name, JSON.stringify(config), createdAt);
      return { id: config.id, name: config.name, config, createdAt };
    },

    createSimulation(input) {
      const id = randomUUID();
      statements.createSimulation.run(
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

    getSimulation,

    listSimulations(filter = {}) {
      const limit = filter.limit ?? 50;
      const rows =
        filter.gameId === undefined
          ? statements.listSimulations.all(limit)
          : statements.listSimulationsForGame.all(filter.gameId, limit);
      return (rows as Row[]).map(toSimulation);
    },

    listSimulationsByStatus: (status) =>
      (statements.listByStatus.all(status) as Row[]).map(toSimulation),

    markRunning(id) {
      statements.markRunning.run(now(), id);
    },

    updateProgress(id, roundsDone) {
      statements.updateProgress.run(roundsDone, id);
    },

    markDone(id, report, verdict) {
      statements.markDone.run(
        now(),
        JSON.stringify(report),
        verdict === null ? null : JSON.stringify(verdict),
        id,
      );
    },

    markFailed(id, error) {
      statements.markFailed.run(now(), error, id);
    },

    close() {
      db.close();
    },
  };
}
