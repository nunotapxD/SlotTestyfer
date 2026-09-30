/**
 * RTP tuner: changes the reel strips, one symbol at a time, until the game pays the target RTP.
 *
 * Each step replaces one regular symbol on one reel with another regular symbol, keeping every
 * reel the same length. Only regular symbols move, so scatter counts, the free spins trigger rate
 * and the wilds stay exactly as designed.
 *
 * Choosing the step is cheap because the line RTP is linear in each reel's frequencies: with the
 * other reels fixed, RTP = sum over symbols s of P(reel r shows s) x C_r(s), where C_r(s) is the
 * expected line prize when reel r shows s. Moving one stop from X to Y changes the RTP by exactly
 * (C_r(Y) - C_r(X)) / reel length (times the free spins factor), so every candidate is scored
 * without recomputing the whole game.
 */
import type { GameConfig } from '@slottestyfer/engine';
import { computeRtp, expectedLinePay, reelDistribution } from './formula.js';

export interface TuneOptions {
  /** Target RTP as a fraction, e.g. 0.96. */
  readonly target: number;
  /** Stop when this close to the target. Default 0.0005 (0.05 percentage points). */
  readonly tolerance?: number;
  /** Most symbols to change. Default 200. */
  readonly maxSteps?: number;
}

export interface TuneStep {
  readonly reel: number;
  readonly from: string;
  readonly to: string;
  /** RTP after this step. */
  readonly rtp: number;
}

export interface TuneResult {
  readonly config: GameConfig;
  readonly startRtp: number;
  readonly rtp: number;
  readonly steps: readonly TuneStep[];
  /** True when the final RTP is within the tolerance of the target. */
  readonly reached: boolean;
}

export function tuneRtp(config: GameConfig, options: TuneOptions): TuneResult {
  const tolerance = options.tolerance ?? 0.0005;
  const maxSteps = options.maxSteps ?? 200;
  const regular = config.symbols.filter((s) => s.kind === 'regular').map((s) => s.id);
  const reels = config.reels.map((strip) => [...strip]);
  const withReels = (): GameConfig => ({ ...config, reels: reels.map((strip) => [...strip]) });

  const start = computeRtp(config);
  let current = start;
  const steps: TuneStep[] = [];

  while (Math.abs(current.rtp - options.target) > tolerance && steps.length < maxSteps) {
    const game = withReels();
    const dists = reels.map(reelDistribution);
    // Free spins multiply every base prize, so a change to the base RTP is scaled by this.
    const factor = current.baseRtp > 0 ? current.rtp / current.baseRtp : 1;

    let best: { reel: number; from: string; to: string; rtp: number } | null = null;
    reels.forEach((strip, r) => {
      // C_r(s): expected line prize with reel r forced to show s.
      const conditional = new Map(
        regular.map((symbol) => {
          const forced = dists.map((d, i) => (i === r ? new Map([[symbol, 1]]) : d));
          return [symbol, expectedLinePay(game, forced)];
        }),
      );
      for (const from of regular) {
        // Keep at least one of each symbol a reel already has.
        if (strip.filter((s) => s === from).length < 2) continue;
        for (const to of regular) {
          if (to === from) continue;
          const delta =
            (((conditional.get(to) ?? 0) - (conditional.get(from) ?? 0)) / strip.length) * factor;
          const rtp = current.rtp + delta;
          if (!best || Math.abs(rtp - options.target) < Math.abs(best.rtp - options.target)) {
            best = { reel: r, from, to, rtp };
          }
        }
      }
    });

    const chosen = best as { reel: number; from: string; to: string; rtp: number } | null;
    if (
      !chosen ||
      Math.abs(chosen.rtp - options.target) >= Math.abs(current.rtp - options.target)
    ) {
      break; // no single change gets closer
    }
    const strip = reels[chosen.reel];
    if (!strip) break;
    strip[strip.lastIndexOf(chosen.from)] = chosen.to;
    current = computeRtp(withReels());
    steps.push({ reel: chosen.reel, from: chosen.from, to: chosen.to, rtp: current.rtp });
  }

  return {
    config: withReels(),
    startRtp: start.rtp,
    rtp: current.rtp,
    steps,
    reached: Math.abs(current.rtp - options.target) <= tolerance,
  };
}
