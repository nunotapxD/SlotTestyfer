/**
 * Descriptive statistics, written out so every formula is visible and tested against values
 * worked out by hand (no black-box library).
 */

export interface Percentiles {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly p999: number;
}

export interface Description {
  readonly count: number;
  readonly mean: number;
  /** Sample standard deviation (divides by n - 1). */
  readonly stdDev: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly percentiles: Percentiles;
  /** Share of values equal to 0 (for wins: rounds that paid nothing). */
  readonly zeroShare: number;
}

/**
 * Percentile of values that are already sorted ascending, by linear interpolation between the
 * two closest ranks (the method numpy uses by default, and Excel's PERCENTILE.INC).
 */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) throw new RangeError('no values');
  if (p < 0 || p > 1) throw new RangeError(`p must be between 0 and 1, got ${p}`);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (rank - low);
}

export function describe(values: ArrayLike<number>): Description {
  const n = values.length;
  if (n === 0) throw new RangeError('no values');
  const sorted = Float64Array.from(values).sort();

  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < n; i++) {
    const v = sorted[i] ?? 0;
    sum += v;
    if (v === 0) zeros++;
  }
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) squares += ((sorted[i] ?? 0) - mean) ** 2;

  return {
    count: n,
    mean,
    stdDev: n > 1 ? Math.sqrt(squares / (n - 1)) : 0,
    min: sorted[0] ?? 0,
    max: sorted[n - 1] ?? 0,
    median: percentileSorted(sorted, 0.5),
    percentiles: {
      p50: percentileSorted(sorted, 0.5),
      p90: percentileSorted(sorted, 0.9),
      p99: percentileSorted(sorted, 0.99),
      p999: percentileSorted(sorted, 0.999),
    },
    zeroShare: zeros / n,
  };
}

/** Longest run of consecutive values equal to 0 (rounds without a win). */
export function longestZeroRun(values: ArrayLike<number>): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export interface Drawdown {
  /** Largest fall from a high point of the running balance, in bets. */
  readonly depth: number;
  /** Round (0-based) of the high point before the fall. -1 if the fall starts at the start. */
  readonly peakRound: number;
  /** Round of the low point. */
  readonly troughRound: number;
}

/**
 * Worst drawdown when betting 1 each round and winning `wins[i]` (in bets): the biggest drop of
 * the running balance from any earlier high point, counting the start as a high point.
 */
export function maxDrawdown(wins: ArrayLike<number>, bet = 1): Drawdown {
  let balance = 0;
  let peak = 0;
  let peakRound = -1;
  let worst: Drawdown = { depth: 0, peakRound: -1, troughRound: -1 };
  for (let i = 0; i < wins.length; i++) {
    balance += (wins[i] ?? 0) - bet;
    if (balance > peak) {
      peak = balance;
      peakRound = i;
    } else if (peak - balance > worst.depth) {
      worst = { depth: peak - balance, peakRound, troughRound: i };
    }
  }
  return worst;
}

/**
 * Shortest losing streak that would be surprising in `rounds` rounds of a game with this hit
 * frequency h. A streak of L or more losses starts at a given round with probability about
 * h x (1 - h)^L (a win, then L losses), so over `rounds` rounds we expect roughly
 * rounds x h x (1 - h)^L of them. The answer is the smallest L where that drops below `alpha`.
 */
export function unusualStreakLength(hitFrequency: number, rounds: number, alpha = 0.01): number {
  if (hitFrequency <= 0) return Infinity;
  if (hitFrequency >= 1) return 1;
  const expectedStarts = Math.max(1, rounds) * hitFrequency;
  return Math.max(1, Math.ceil(Math.log(alpha / expectedStarts) / Math.log(1 - hitFrequency)));
}

/** Plain-language volatility band from the standard deviation of one round, in bets. */
export type VolatilityBand = 'low' | 'medium' | 'high' | 'very high';

export function volatilityBand(stdDev: number): VolatilityBand {
  if (stdDev < 2) return 'low';
  if (stdDev < 6) return 'medium';
  if (stdDev < 15) return 'high';
  return 'very high';
}
