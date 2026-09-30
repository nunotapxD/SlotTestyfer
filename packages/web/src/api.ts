/**
 * Typed client for the SlotTestyfer API. Every call goes to /api, which Vite (in development),
 * nginx (in Docker) or the API itself (all-in-one deploy) routes to the API.
 */
import type { Position } from './lib/game.js';

export const API_BASE = '/api';

export interface GameSummary {
  id: string;
  name: string;
  reels: number;
  rows: number;
  paylines: number;
  freeSpins: boolean;
  /** Exact RTP by formula, as a fraction. */
  rtp: number;
}

export interface GameConfig {
  id: string;
  name: string;
  rows: number;
  symbols: { id: string; kind: 'regular' | 'wild' | 'scatter' }[];
  reels: string[][];
  paylines: number[][];
  paytable: { symbol: string; count: number; pays: number }[];
  freeSpins?: { symbol: string; count: number; spins: number; multiplier: number };
}

export interface LineWin {
  payline: number;
  symbol: string;
  count: number;
  pays: number;
  wilds: number;
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

export interface FreeSpin {
  stops: number[];
  screen: string[][];
  win: number;
  lineWins: LineWin[];
  scatterWins: ScatterWin[];
}

export interface Round {
  gameId: string;
  seed: number;
  bet: number;
  /** Everything the round paid, free spins included. */
  win: number;
  multiplier: number;
  stops: number[];
  screen: string[][];
  lineWins: LineWin[];
  scatterWins: ScatterWin[];
  freeSpins: { multiplier: number; win: number; spins: FreeSpin[] } | null;
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
  rtpByFeature: { lines: number; scatters: number; freeSpins: number; wildAssisted: number };
  featureFrequency: number;
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

export type LiveStatus = 'running' | 'paused' | 'finished' | 'cancelled' | 'failed';

export interface LivePlayer {
  id: number;
  balance: number;
  rounds: number;
  busted: boolean;
}

export interface LiveAlert {
  kind: 'rtp-out-of-range' | 'rtp-back-in-range' | 'losing-streak';
  rounds: number;
  message: string;
}

export interface LiveBatch {
  seq: number;
  rounds: number;
  rtp: number;
  low: number;
  high: number;
  hitFrequency: number;
  maxWin: number;
  stdDev: number;
  featureFrequency: number;
  longestLosingStreak: number;
  verdict: { status: Verdict['status']; final: boolean };
  players: LivePlayer[];
  alerts: LiveAlert[];
  roundsPerSecond: number;
}

export interface LiveState {
  id: string;
  game: { id: string; name: string };
  settings: {
    seed: number;
    target: number;
    tolerance: number;
    players: number;
    roundsPerSecond: number;
    maxRounds: number;
  };
  status: LiveStatus;
  startedAt: string;
  last: LiveBatch | null;
  error: string | null;
}

export interface LiveSnapshot extends LiveState {
  history: {
    rounds: number;
    rtp: number;
    low: number;
    high: number;
    players: number[];
    playerRounds: number;
  }[];
  alerts: LiveAlert[];
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

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      // Only send a JSON content type with a body: an empty JSON body is an error for Fastify.
      ...(json === undefined
        ? {}
        : { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }),
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

const id = (value: string) => encodeURIComponent(value);

export const api = {
  listGames: () => request<GameSummary[]>('/games'),
  getGame: (gameId: string) => request<GameConfig>(`/games/${id(gameId)}`),
  spin: (gameId: string, bet: number, seed?: number) =>
    request<Round>('/spin', {
      method: 'POST',
      json: seed === undefined ? { gameId, bet } : { gameId, bet, seed },
    }),
  startSimulation: (input: {
    gameId: string;
    spins: number;
    seed?: number;
    target?: number;
    tolerance?: number;
  }) => request<Simulation>('/simulations', { method: 'POST', json: input }),
  getSimulation: (simId: string) => request<Simulation>(`/simulations/${id(simId)}`),
  listSimulations: (limit = 8) => request<Simulation[]>(`/simulations?limit=${limit}`),
  simulationCsvUrl: (simId: string) => `${API_BASE}/simulations/${id(simId)}/report.csv`,

  startLive: (input: {
    gameId: string;
    roundsPerSecond: number;
    target?: number;
    tolerance?: number;
    players?: number;
    seed?: number;
  }) => request<LiveState>('/live', { method: 'POST', json: input }),
  liveCommand: (runId: string, command: 'pause' | 'resume' | 'cancel') =>
    request<LiveState>(`/live/${id(runId)}/${command}`, { method: 'POST' }),
  liveSpeed: (runId: string, roundsPerSecond: number) =>
    request<LiveState>(`/live/${id(runId)}/speed`, { method: 'PUT', json: { roundsPerSecond } }),
  liveEventsUrl: (runId: string) => `${API_BASE}/live/${id(runId)}/events`,
};
