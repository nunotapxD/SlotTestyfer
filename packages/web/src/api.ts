/**
 * Typed client for the SlotTestyfer API. Every call goes to /api, which Vite (in development) or
 * nginx (in Docker) forwards to the API server.
 */
import type { Position } from './lib/game.js';

const BASE = '/api';

export interface GameSummary {
  id: string;
  name: string;
  reels: number;
  rows: number;
  paylines: number;
}

export interface GameConfig {
  id: string;
  name: string;
  rows: number;
  symbols: { id: string; kind: 'regular' | 'wild' | 'scatter' }[];
  reels: string[][];
  paylines: number[][];
  paytable: { symbol: string; count: number; pays: number }[];
}

export interface LineWin {
  payline: number;
  symbol: string;
  count: number;
  pays: number;
  win: number;
  positions: Position[];
}

export interface ScatterWin {
  symbol: string;
  count: number;
  pays: number;
  win: number;
  positions: Position[];
}

export interface Round {
  gameId: string;
  seed: number;
  bet: number;
  win: number;
  multiplier: number;
  stops: number[];
  screen: string[][];
  lineWins: LineWin[];
  scatterWins: ScatterWin[];
}

export interface Report {
  rounds: number;
  rtp: number;
  rtpBySymbol: { symbol: string; rtp: number }[];
  hitFrequency: number;
  maxWin: number;
  stdDev: number;
  standardError: number;
  interval: { confidence: number; low: number; high: number };
  histogram: { label: string; rounds: number; share: number }[];
}

export interface Verdict {
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  target: number;
  tolerance: number;
  reason: string;
  roundsNeeded?: number;
}

export type SimulationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Simulation {
  id: string;
  gameId: string;
  spins: number;
  seed: number;
  target: number | null;
  tolerance: number;
  status: SimulationStatus;
  roundsDone: number;
  progress: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: Report | null;
  verdict: Verdict | null;
  error: string | null;
}

/** Error returned by the API, or a network failure. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly issues: readonly string[];

  constructor(status: number, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiRequestError(0, 'The API is not reachable. Start it with npm run api.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body ?? {}) as { message?: string; issues?: string[] };
    throw new ApiRequestError(
      response.status,
      error.message ?? `The API answered ${response.status}.`,
      error.issues ?? [],
    );
  }
  return body as T;
}

export const api = {
  listGames: () => request<GameSummary[]>('/games'),
  getGame: (id: string) => request<GameConfig>(`/games/${encodeURIComponent(id)}`),
  spin: (gameId: string, bet: number, seed?: number) =>
    request<Round>('/spin', {
      method: 'POST',
      body: JSON.stringify(seed === undefined ? { gameId, bet } : { gameId, bet, seed }),
    }),
  startSimulation: (input: {
    gameId: string;
    spins: number;
    seed?: number;
    target?: number;
    tolerance?: number;
  }) => request<Simulation>('/simulations', { method: 'POST', body: JSON.stringify(input) }),
  getSimulation: (id: string) => request<Simulation>(`/simulations/${encodeURIComponent(id)}`),
  listSimulations: (limit = 8) => request<Simulation[]>(`/simulations?limit=${limit}`),
};
