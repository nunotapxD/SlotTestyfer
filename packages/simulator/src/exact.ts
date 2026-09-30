/**
 * Exact analysis: plays every possible combination of reel stops once.
 *
 * Every stop is equally likely, so averaging over all combinations gives the true RTP, hit
 * frequency and volatility, with no sampling error. It is only practical when the number of
 * combinations is small (3 reels of 20 stops = 8,000; 5 reels of 30 stops = 24 million), which
 * is why real games are also checked by Monte Carlo. Here it is used to verify the simulator.
 */
import { createEvaluator, screenFromStops, type GameConfig } from '@slottestyfer/engine';
import { summarize, type Report } from './report.js';
import { emptyStats, recordRound } from './stats.js';

export const DEFAULT_MAX_COMBINATIONS = 10_000_000;

export function countCombinations(config: GameConfig): number {
  return config.reels.reduce((total, strip) => total * strip.length, 1);
}

export interface ExactResult {
  readonly combinations: number;
  /** Same fields as a simulation report; standardError and interval are 0 by definition. */
  readonly report: Report;
}

export function analyzeExact(
  config: GameConfig,
  maxCombinations = DEFAULT_MAX_COMBINATIONS,
): ExactResult {
  const combinations = countCombinations(config);
  if (combinations > maxCombinations) {
    throw new RangeError(
      `${combinations} combinations is more than the limit of ${maxCombinations}; use a simulation`,
    );
  }

  const evaluator = createEvaluator(config);
  const stats = emptyStats(config.paylines.length);
  const stops = config.reels.map(() => 0);

  // Odometer: advance the last reel, carry into the previous one when it wraps.
  for (let done = 0; done < combinations; done++) {
    recordRound(stats, evaluator(screenFromStops(config, stops)));
    for (let reel = stops.length - 1; reel >= 0; reel--) {
      const next = (stops[reel] ?? 0) + 1;
      if (next < (config.reels[reel]?.length ?? 0)) {
        stops[reel] = next;
        break;
      }
      stops[reel] = 0;
    }
  }

  const sampled = summarize(stats);
  // Every combination was counted once: this is the population, not a sample.
  const variance = Math.max(
    0,
    stats.sumSquares / (stats.lines * stats.lines) / combinations - sampled.rtp ** 2,
  );
  const report: Report = {
    ...sampled,
    stdDev: Math.sqrt(variance),
    standardError: 0,
    interval: { confidence: 1, low: sampled.rtp, high: sampled.rtp },
  };
  return { combinations, report };
}
