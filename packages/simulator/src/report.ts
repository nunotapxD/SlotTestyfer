/**
 * Turning raw totals into the numbers a game certifier looks at, and the PASS/FAIL verdict.
 */
import { HISTOGRAM_LABELS, type SimStats } from './stats.js';

/** z-score for a two-sided 95% confidence interval. */
export const Z_95 = 1.959963984540054;

export interface Report {
  readonly rounds: number;
  /** Return to player: total won / total bet. 0.96 means 96%. */
  readonly rtp: number;
  /** How much of the RTP comes from each symbol, biggest first. */
  readonly rtpBySymbol: readonly { readonly symbol: string; readonly rtp: number }[];
  /** Share of rounds that won anything. */
  readonly hitFrequency: number;
  /** Biggest single-round win, as a multiple of the total bet. */
  readonly maxWin: number;
  /** Standard deviation of one round's win, in total bets. A measure of volatility. */
  readonly stdDev: number;
  /** Standard error of the RTP estimate: stdDev / sqrt(rounds). */
  readonly standardError: number;
  /** Confidence interval for the true RTP. */
  readonly interval: { readonly confidence: number; readonly low: number; readonly high: number };
  readonly histogram: readonly {
    readonly label: string;
    readonly rounds: number;
    readonly share: number;
  }[];
}

export function summarize(stats: SimStats, z = Z_95, confidence = 0.95): Report {
  const n = stats.rounds;
  if (n === 0) throw new Error('cannot summarize zero rounds');
  const lines = stats.lines;

  const rtp = stats.totalWin / lines / n;
  const meanSquare = stats.sumSquares / (lines * lines) / n;
  // Sample variance (n - 1) so a small run does not look more stable than it is.
  const variance = n > 1 ? Math.max(0, meanSquare - rtp * rtp) * (n / (n - 1)) : 0;
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);

  const rtpBySymbol = Object.entries(stats.bySymbol)
    .map(([symbol, win]) => ({ symbol, rtp: win / lines / n }))
    .sort((a, b) => b.rtp - a.rtp || a.symbol.localeCompare(b.symbol));

  return {
    rounds: n,
    rtp,
    rtpBySymbol,
    hitFrequency: stats.hits / n,
    maxWin: stats.maxWin / lines,
    stdDev,
    standardError,
    interval: { confidence, low: rtp - z * standardError, high: rtp + z * standardError },
    histogram: HISTOGRAM_LABELS.map((label, i) => {
      const rounds = stats.histogram[i] ?? 0;
      return { label, rounds, share: rounds / n };
    }),
  };
}

export type VerdictStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface Verdict {
  readonly status: VerdictStatus;
  readonly target: number;
  readonly tolerance: number;
  readonly reason: string;
  /** For INCONCLUSIVE: roughly how many rounds would settle it, if the estimate holds. */
  readonly roundsNeeded?: number;
}

/**
 * Compares the RTP against `target ± tolerance`, taking the uncertainty into account:
 * - PASS when the whole confidence interval is inside the allowed range.
 * - FAIL when the whole interval is outside it.
 * - INCONCLUSIVE when the interval crosses a limit: more rounds are needed to decide.
 */
export function certify(report: Report, target: number, tolerance: number, z = Z_95): Verdict {
  if (!(tolerance > 0)) throw new RangeError(`tolerance must be positive, got ${tolerance}`);
  const min = target - tolerance;
  const max = target + tolerance;
  const { low, high } = report.interval;

  if (low >= min && high <= max) {
    return { status: 'PASS', target, tolerance, reason: 'confidence interval inside the range' };
  }
  if (high < min || low > max) {
    return { status: 'FAIL', target, tolerance, reason: 'confidence interval outside the range' };
  }

  const margin = tolerance - Math.abs(report.rtp - target);
  if (margin <= 0) {
    return {
      status: 'INCONCLUSIVE',
      target,
      tolerance,
      reason: 'estimate is outside the range but the interval still reaches it',
    };
  }
  // Need z * stdDev / sqrt(n) <= margin, so n >= (z * stdDev / margin)^2.
  const roundsNeeded = Math.ceil(((z * report.stdDev) / margin) ** 2);
  return {
    status: 'INCONCLUSIVE',
    target,
    tolerance,
    reason: 'interval crosses a limit of the range',
    roundsNeeded,
  };
}
