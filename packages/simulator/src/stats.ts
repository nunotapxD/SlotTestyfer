/**
 * Accumulated results of many rounds.
 *
 * Only running totals are kept, never the rounds themselves, so memory stays constant whether
 * we simulate a thousand rounds or a billion. Wins are counted in whole line bets, which makes
 * every total an exact integer: merging results from several workers gives exactly the same
 * numbers in any order.
 */
import type { Evaluation, RoundOutcome } from '@slottestyfer/engine';

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
  /** Win per symbol, in line bets (free spins included, multiplier applied). */
  bySymbol: Record<string, number>;
  /** Line wins in the base spin, in line bets. */
  baseLineWin: number;
  /** Scatter wins in the base spin, in line bets. */
  baseScatterWin: number;
  /** Everything won in free spins, multiplier applied, in line bets. */
  freeSpinsWin: number;
  /** Line wins (base and free spins) that needed at least one wild, in line bets. */
  wildLineWin: number;
  /** Rounds that triggered free spins. */
  triggers: number;
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
    baseLineWin: 0,
    baseScatterWin: 0,
    freeSpinsWin: 0,
    wildLineWin: 0,
    triggers: 0,
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

/** Adds one spin's wins per symbol and per kind, scaled by a multiplier. */
function addSpin(stats: SimStats, evaluation: Evaluation, multiplier: number): void {
  for (const lineWin of evaluation.lineWins) {
    const win = lineWin.pays * multiplier;
    stats.bySymbol[lineWin.symbol] = (stats.bySymbol[lineWin.symbol] ?? 0) + win;
    if (lineWin.wilds > 0) stats.wildLineWin += win;
  }
  for (const scatterWin of evaluation.scatterWins) {
    stats.bySymbol[scatterWin.symbol] =
      (stats.bySymbol[scatterWin.symbol] ?? 0) + scatterWin.pays * stats.lines * multiplier;
  }
}

/** Adds one complete round (base spin and any free spins) to the totals. */
export function recordRound(stats: SimStats, outcome: RoundOutcome): void {
  const win = outcome.winLineBets;
  stats.rounds += 1;
  stats.totalWin += win;
  stats.sumSquares += win * win;
  if (win > 0) stats.hits += 1;
  if (win > stats.maxWin) stats.maxWin = win;

  const base = outcome.base.evaluation;
  addSpin(stats, base, 1);
  for (const lineWin of base.lineWins) stats.baseLineWin += lineWin.pays;
  for (const scatterWin of base.scatterWins) stats.baseScatterWin += scatterWin.pays * stats.lines;

  const feature = outcome.freeSpins;
  if (feature) {
    stats.triggers += 1;
    stats.freeSpinsWin += feature.winLineBets;
    for (const spin of feature.spins) addSpin(stats, spin.evaluation, feature.multiplier);
  }

  const bucket = histogramBucket(outcome.multiplier);
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
    baseLineWin: a.baseLineWin + b.baseLineWin,
    baseScatterWin: a.baseScatterWin + b.baseScatterWin,
    freeSpinsWin: a.freeSpinsWin + b.freeSpinsWin,
    wildLineWin: a.wildLineWin + b.wildLineWin,
    triggers: a.triggers + b.triggers,
    histogram: a.histogram.map((count, i) => count + (b.histogram[i] ?? 0)),
  };
}
