/**
 * Persistence for games and simulations: the types and the Store interface.
 *
 * Two implementations: SQLite built into Node.js (sqlite-store.ts), the default, with no server to
 * run; and PostgreSQL (postgres-store.ts), used when DATABASE_URL is set. The rest of the API only
 * talks to this interface, so it does not know which one it has.
 */
import type { GameConfig } from '@slottestyfer/engine';
import type { Report, Verdict } from '@slottestyfer/simulator/core';

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
  /** 'sqlite' or 'postgres', for logs and /health. */
  readonly kind: string;

  listGames(): Promise<StoredGame[]>;
  getGame(id: string): Promise<StoredGame | undefined>;
  /** Adds a validated game. Rejects with GameExistsError if the id is taken. */
  addGame(config: GameConfig): Promise<StoredGame>;

  createSimulation(input: NewSimulation): Promise<SimulationRecord>;
  getSimulation(id: string): Promise<SimulationRecord | undefined>;
  /** Most recent first. */
  listSimulations(filter?: { gameId?: string; limit?: number }): Promise<SimulationRecord[]>;
  /** Oldest first, for the runner's queue. */
  listSimulationsByStatus(status: SimulationStatus): Promise<SimulationRecord[]>;
  markRunning(id: string): Promise<void>;
  /** Only changes simulations that are still running. */
  updateProgress(id: string, roundsDone: number): Promise<void>;
  markDone(id: string, report: Report, verdict: Verdict | null): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;

  close(): Promise<void>;
}
