/**
 * A full analysis of one game, and the side-by-side comparison of several. Answers questions such
 * as "is this game volatile?" and "how long does a player with 100 credits last?" with numbers.
 */
import type { GameConfig } from '@slottestyfer/engine';
import { computeRtp, summarize, type Report, type RtpFormula } from '@slottestyfer/simulator/core';
import { convergence, type ConvergencePoint } from './convergence.js';
import { sampleRounds } from './sample.js';
import { simulateSessions, type SessionResult } from './sessions.js';
import {
  describe,
  longestZeroRun,
  unusualStreakLength,
  volatilityBand,
  type Description,
  type VolatilityBand,
} from './stats.js';

export interface AnalysisOptions {
  /** Rounds kept one by one. Default 100,000. */
  readonly rounds?: number;
  /** Player sessions. Default 1000. */
  readonly sessions?: number;
  /** Starting balance of each session, in credits. Default 100. */
  readonly balance?: number;
  /** Round limit per session. Default 1000. */
  readonly maxRounds?: number;
  readonly seed: number;
  /** Progress from 0 to 1. */
  readonly onProgress?: (fraction: number, stage: 'rounds' | 'sessions') => void;
}

export interface GameAnalysis {
  readonly game: { readonly id: string; readonly name: string };
  readonly seed: number;
  /** Exact RTP by formula, to compare the sample against. */
  readonly exact: RtpFormula;
  /** Report of the sampled rounds (RTP, hit frequency, breakdown by feature and symbol). */
  readonly report: Report;
  /** Win per round, in bets. */
  readonly wins: Description;
  readonly volatility: { readonly stdDev: number; readonly band: VolatilityBand };
  readonly streaks: {
    /** Longest run of rounds without a win in the sample. */
    readonly longestLosing: number;
    /** A streak this long would appear with probability < 1% in this many rounds. */
    readonly unusualFrom: number;
  };
  readonly convergence: readonly ConvergencePoint[];
  readonly sessions: SessionResult;
}

export function analyzeGame(config: GameConfig, options: AnalysisOptions): GameAnalysis {
  const rounds = options.rounds ?? 100_000;
  const sample = sampleRounds(config, rounds, options.seed, (done) =>
    options.onProgress?.(done / rounds, 'rounds'),
  );
  const report = summarize(sample.stats);
  const sessions = simulateSessions(config, {
    seed: options.seed,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.balance === undefined ? {} : { balance: options.balance }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    onProgress: (done, total) => options.onProgress?.(done / total, 'sessions'),
  });

  return {
    game: { id: config.id, name: config.name },
    seed: options.seed,
    exact: computeRtp(config),
    report,
    wins: describe(sample.wins),
    volatility: { stdDev: report.stdDev, band: volatilityBand(report.stdDev) },
    streaks: {
      longestLosing: longestZeroRun(sample.wins),
      unusualFrom: unusualStreakLength(report.hitFrequency, report.rounds),
    },
    convergence: convergence(sample.wins),
    sessions,
  };
}

export interface ComparisonRow {
  readonly metric: string;
  readonly unit: 'fraction' | 'bets' | 'rounds' | 'credits' | 'text';
  /** One value per game, in the order the games were given. */
  readonly values: readonly (number | string)[];
}

/** The same numbers for every game, one row per metric, ready for a table or a CSV. */
export function compareGames(analyses: readonly GameAnalysis[]): ComparisonRow[] {
  const row = (
    metric: string,
    unit: ComparisonRow['unit'],
    pick: (a: GameAnalysis) => number | string,
  ): ComparisonRow => ({ metric, unit, values: analyses.map(pick) });

  const checkpoints = analyses[0]?.sessions.checkpoints.map((c) => c.rounds) ?? [];
  return [
    row('RTP (exact)', 'fraction', (a) => a.exact.rtp),
    row('RTP (sample)', 'fraction', (a) => a.report.rtp),
    row('Hit frequency', 'fraction', (a) => a.report.hitFrequency),
    row('Volatility (std dev)', 'bets', (a) => a.volatility.stdDev),
    row('Volatility band', 'text', (a) => a.volatility.band),
    row('Free spins trigger', 'fraction', (a) => a.exact.triggerProbability),
    row('Median win', 'bets', (a) => a.wins.median),
    row('P90 win', 'bets', (a) => a.wins.percentiles.p90),
    row('P99 win', 'bets', (a) => a.wins.percentiles.p99),
    row('Max win', 'bets', (a) => a.wins.max),
    row('Longest losing streak', 'rounds', (a) => a.streaks.longestLosing),
    row('Median session length', 'rounds', (a) => a.sessions.length.median),
    row('Median drawdown per session', 'credits', (a) => a.sessions.drawdown.median),
    row('Worst drawdown in a session', 'credits', (a) => a.sessions.drawdown.max),
    row('Players who ran out', 'fraction', (a) => a.sessions.bustedShare),
    ...checkpoints.map((rounds, i) =>
      row(`Ahead after ${rounds} rounds`, 'fraction', (a) => a.sessions.checkpoints[i]?.ahead ?? 0),
    ),
  ];
}

/** A sentence per question, for the CLI and the README. */
export function summarizeInWords(a: GameAnalysis): string[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const s = a.sessions;
  const lines = [
    `${a.game.name} pays back ${pct(a.exact.rtp)} of what is bet in the long run.`,
    `Volatility is ${a.volatility.band}: one round swings by ${a.volatility.stdDev.toFixed(2)} bets on average, ` +
      `${pct(a.report.hitFrequency)} of rounds win something, and 1 round in 100 wins ${a.wins.percentiles.p99.toFixed(1)}x or more.`,
    s.length.median >= s.maxRounds
      ? `A player with ${s.startBalance} credits betting 1 per round usually outlasts the ${s.maxRounds}-round limit: ` +
        `${pct(1 - s.bustedShare)} are still playing, ${pct(s.bustedShare)} ran out first.`
      : `A player with ${s.startBalance} credits betting 1 per round lasts ${Math.round(s.length.median)} rounds (median); ` +
        `${pct(s.bustedShare)} run out before ${s.maxRounds} rounds.`,
  ];
  for (const c of s.checkpoints) {
    lines.push(`After ${c.rounds} rounds, ${pct(c.ahead)} of players are ahead.`);
  }
  lines.push(
    `The longest losing streak in ${a.report.rounds.toLocaleString('en-US')} rounds was ${a.streaks.longestLosing} ` +
      `(one of ${a.streaks.unusualFrom}+ would be unusual in that many rounds).`,
    `In a typical session the balance falls ${s.drawdown.median.toFixed(0)} credits from its best point; ` +
      `the worst session fell ${s.drawdown.max.toFixed(0)}.`,
  );
  return lines;
}
