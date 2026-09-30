/**
 * Accumulated results of many rounds.
 *
 * Only running totals are kept, never the rounds themselves, so memory stays constant whether
 * we simulate a thousand rounds or a billion. Wins are counted in whole line bets, which makes
 * every total an exact integer: merging results from several workers gives exactly the same
 * numbers in any order.
 */
import type { Evaluation } from '@slottestyfer/engine';

/** Upper bounds (exclusive) of the win buckets, as multiples of the total bet. */
export const HISTOGRAM_EDGES = [1, 2, 5, 20] as const;
export const HISTOGRAM_LABELS = ['0x', '0-1x', '1-2x', '2-5x', '5-20x', '20x+'] as const;

export interface SimStats {
  /** Paylines in the game: converts line bets into multiples of the total bet. */
  readonly lines: number;
  rounds: number;
  /** Sum of wins, in line bets. */
  totalWin: number;
  /** Sum of squared wins, in line bets squared. Gives the variance. */
  sumSquares: number;
  /** Rounds that won anything. */
  hits: number;
  /** Biggest single-round win, in line bets. */
  maxWin: number;
  /** Win per symbol, in line bets. */
  bySymbol: Record<string, number>;
  /** Rounds per bucket of HISTOGRAM_LABELS. */
  histogram: number[];
}

export function emptyStats(lines: number): SimStats {
  return {
    lines,
    rounds: 0,
    totalWin: 0,
    sumSquares: 0,
    hits: 0,
    maxWin: 0,
    bySymbol: {},
    histogram: HISTOGRAM_LABELS.map(() => 0),
  };
}

export function histogramBucket(multiplier: number): number {
  if (multiplier === 0) return 0;
  for (let i = 0; i < HISTOGRAM_EDGES.length; i++) {
    if (multiplier < (HISTOGRAM_EDGES[i] ?? Infinity)) return i + 1;
  }
  return HISTOGRAM_EDGES.length + 1;
}

/** Adds one evaluated round to the totals. */
export function recordRound(stats: SimStats, evaluation: Evaluation): void {
  const win = evaluation.winLineBets;
  stats.rounds += 1;
  stats.totalWin += win;
  stats.sumSquares += win * win;
  if (win > 0) stats.hits += 1;
  if (win > stats.maxWin) stats.maxWin = win;

  for (const lineWin of evaluation.lineWins) {
    stats.bySymbol[lineWin.symbol] = (stats.bySymbol[lineWin.symbol] ?? 0) + lineWin.pays;
  }
  for (const scatterWin of evaluation.scatterWins) {
    stats.bySymbol[scatterWin.symbol] =
      (stats.bySymbol[scatterWin.symbol] ?? 0) + scatterWin.pays * stats.lines;
  }

  const bucket = histogramBucket(evaluation.multiplier);
  stats.histogram[bucket] = (stats.histogram[bucket] ?? 0) + 1;
}

/** Combines two sets of totals into a new one. */
export function mergeStats(a: SimStats, b: SimStats): SimStats {
  if (a.lines !== b.lines) {
    throw new Error(`cannot merge results from games with ${a.lines} and ${b.lines} paylines`);
  }
  const bySymbol = { ...a.bySymbol };
  for (const [symbol, win] of Object.entries(b.bySymbol)) {
    bySymbol[symbol] = (bySymbol[symbol] ?? 0) + win;
  }
  return {
    lines: a.lines,
    rounds: a.rounds + b.rounds,
    totalWin: a.totalWin + b.totalWin,
    sumSquares: a.sumSquares + b.sumSquares,
    hits: a.hits + b.hits,
    maxWin: Math.max(a.maxWin, b.maxWin),
    bySymbol,
    histogram: a.histogram.map((count, i) => count + (b.histogram[i] ?? 0)),
  };
}
