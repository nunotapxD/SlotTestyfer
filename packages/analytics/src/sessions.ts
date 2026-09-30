/**
 * Player sessions: how long does a balance of 100 credits last, and how likely is a player to be
 * ahead after 100, 500 or 1000 rounds?
 *
 * Each session starts with the same balance and bets 1 credit per round until it cannot cover the
 * next bet or reaches the round limit. Everything is counted in line bets (whole numbers), so the
 * balances are exact.
 */
import { createRng, createRoundEngine, deriveSeed, type GameConfig } from '@slottestyfer/engine';
import { describe, percentileSorted } from './stats.js';

export interface SessionOptions {
  /** Number of players simulated. Default 1000. */
  readonly sessions?: number;
  /** Starting balance in credits. Default 100. */
  readonly balance?: number;
  /** Round limit per session. Default 1000. */
  readonly maxRounds?: number;
  /** Rounds at which to measure the chance of being ahead. Default 100, 500, 1000. */
  readonly checkpoints?: readonly number[];
  /** How many balance trajectories to keep for charts. Default 12. */
  readonly trajectories?: number;
  readonly seed: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface CheckpointResult {
  readonly rounds: number;
  /** Share of players with more than they started with at this round. */
  readonly ahead: number;
  /** Share of players who ran out of credits before this round. */
  readonly busted: number;
}

export interface SessionResult {
  readonly sessions: number;
  readonly startBalance: number;
  readonly maxRounds: number;
  /** Rounds played before running out (maxRounds if the player never ran out). */
  readonly length: {
    readonly median: number;
    readonly p10: number;
    readonly p90: number;
    readonly mean: number;
  };
  /** Share of players who ran out of credits before the round limit. */
  readonly bustedShare: number;
  readonly checkpoints: readonly CheckpointResult[];
  /** survival[i] = share of players still playing after round i + 1 (one value per round). */
  readonly survival: readonly number[];
  /** Balance in credits after each round, for the first few sessions. */
  readonly trajectories: readonly (readonly number[])[];
  /** Final balances in credits, described. */
  readonly finalBalance: ReturnType<typeof describe>;
  /**
   * Worst drawdown of each session (largest fall from its own high point, in credits), described:
   * how bad the worst stretch of a typical session feels.
   */
  readonly drawdown: ReturnType<typeof describe>;
}

export function simulateSessions(config: GameConfig, options: SessionOptions): SessionResult {
  const sessions = options.sessions ?? 1000;
  const startBalance = options.balance ?? 100;
  const maxRounds = options.maxRounds ?? 1000;
  const checkpoints = (options.checkpoints ?? [100, 500, 1000]).filter((c) => c <= maxRounds);
  const keep = options.trajectories ?? 12;
  const lines = config.paylines.length;
  const play = createRoundEngine(config);

  const lengths = new Float64Array(sessions);
  const finals = new Float64Array(sessions);
  const drawdowns = new Float64Array(sessions);
  const stillPlaying = new Float64Array(maxRounds);
  const ahead = checkpoints.map(() => 0);
  const busted = checkpoints.map(() => 0);
  const trajectories: number[][] = [];
  let bustedCount = 0;

  for (let s = 0; s < sessions; s++) {
    const rng = createRng(deriveSeed(options.seed, s));
    const start = startBalance * lines; // in line bets
    let balance = start;
    let peak = start;
    let worstDrop = 0;
    let round = 0;
    const path: number[] | null = s < keep ? [] : null;

    while (round < maxRounds && balance >= lines) {
      balance += play(rng).winLineBets - lines;
      round++;
      if (balance > peak) peak = balance;
      else if (peak - balance > worstDrop) worstDrop = peak - balance;
      stillPlaying[round - 1] = (stillPlaying[round - 1] ?? 0) + 1;
      path?.push(balance / lines);
      checkpoints.forEach((c, i) => {
        if (round === c && balance > start) ahead[i] = (ahead[i] ?? 0) + 1;
      });
    }
    const ranOut = balance < lines;
    if (ranOut) {
      bustedCount++;
      checkpoints.forEach((c, i) => {
        if (round < c) busted[i] = (busted[i] ?? 0) + 1;
      });
    }
    lengths[s] = round;
    finals[s] = balance / lines;
    drawdowns[s] = worstDrop / lines;
    if (path) trajectories.push(path);
    options.onProgress?.(s + 1, sessions);
  }

  const sortedLengths = Float64Array.from(lengths).sort();
  return {
    sessions,
    startBalance,
    maxRounds,
    length: {
      median: percentileSorted(sortedLengths, 0.5),
      p10: percentileSorted(sortedLengths, 0.1),
      p90: percentileSorted(sortedLengths, 0.9),
      mean: sortedLengths.reduce((a, b) => a + b, 0) / sessions,
    },
    bustedShare: bustedCount / sessions,
    checkpoints: checkpoints.map((rounds, i) => ({
      rounds,
      ahead: (ahead[i] ?? 0) / sessions,
      busted: (busted[i] ?? 0) / sessions,
    })),
    survival: Array.from(stillPlaying, (n) => n / sessions),
    trajectories,
    finalBalance: describe(finals),
    drawdown: describe(drawdowns),
  };
}
