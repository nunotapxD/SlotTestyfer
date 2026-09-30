/**
 * A complete round: the base spin and, if it triggers them, the free spins.
 *
 * Free spins are played at the same bet, on the same reels, with every win multiplied by the
 * feature's multiplier. They do not retrigger, which keeps the maths easy to check: the RTP of a
 * game with free spins is RTP(base) x (1 + P(trigger) x spins x multiplier).
 *
 * Credits are fictional; this engine never handles real money.
 */
import type { GameConfig } from './config.js';
import { createEvaluator, type Evaluation } from './evaluate.js';
import type { Rng } from './rng.js';
import { spin, type Screen } from './spin.js';

/** One spin of the reels and what it paid (before any free spins multiplier). */
export interface SpinOutcome {
  readonly stops: readonly number[];
  readonly screen: Screen;
  readonly evaluation: Evaluation;
}

export interface FreeSpinsOutcome {
  readonly spins: readonly SpinOutcome[];
  readonly multiplier: number;
  /** Total of the free spins in line bets, with the multiplier applied. */
  readonly winLineBets: number;
}

export interface RoundOutcome {
  readonly base: SpinOutcome;
  /** null when the base spin did not trigger free spins (or the game has none). */
  readonly freeSpins: FreeSpinsOutcome | null;
  /** Whole round in line bets: base win + free spins win. Always a whole number. */
  readonly winLineBets: number;
  /** Whole round as a multiple of the total bet. */
  readonly multiplier: number;
}

export type RoundEngine = (rng: Rng) => RoundOutcome;

/** How many times a symbol appears anywhere on the screen. */
export function countSymbol(screen: Screen, symbol: string): number {
  let count = 0;
  for (const column of screen) for (const s of column) if (s === symbol) count++;
  return count;
}

/** Prepares a game once and returns a function that plays whole rounds (in line bets). */
export function createRoundEngine(config: GameConfig): RoundEngine {
  const evaluator = createEvaluator(config);
  const lines = config.paylines.length;
  const feature = config.freeSpins;

  const spinOnce = (rng: Rng): SpinOutcome => {
    const { stops, screen } = spin(config, rng);
    return { stops, screen, evaluation: evaluator(screen) };
  };

  return (rng) => {
    const base = spinOnce(rng);
    let freeSpins: FreeSpinsOutcome | null = null;

    if (feature && countSymbol(base.screen, feature.symbol) >= feature.count) {
      const spins: SpinOutcome[] = [];
      let total = 0;
      for (let i = 0; i < feature.spins; i++) {
        const outcome = spinOnce(rng);
        spins.push(outcome);
        total += outcome.evaluation.winLineBets;
      }
      freeSpins = {
        spins,
        multiplier: feature.multiplier,
        winLineBets: total * feature.multiplier,
      };
    }

    const winLineBets = base.evaluation.winLineBets + (freeSpins?.winLineBets ?? 0);
    return { base, freeSpins, winLineBets, multiplier: winLineBets / lines };
  };
}

export interface RoundResult {
  readonly betCents: number;
  /** Everything the round paid: base spin plus free spins. */
  readonly winCents: number;
  /** The base spin (kept at the top level for convenience). */
  readonly stops: readonly number[];
  readonly screen: Screen;
  readonly evaluation: Evaluation;
  readonly freeSpins: {
    readonly multiplier: number;
    readonly winCents: number;
    readonly spins: readonly (SpinOutcome & { readonly winCents: number })[];
  } | null;
}

export type RoundPlayer = (rng: Rng, betCents: number) => RoundResult;

/** Prepares a game once and returns a function that plays rounds for a bet in cents. */
export function createRoundPlayer(config: GameConfig): RoundPlayer {
  const engine = createRoundEngine(config);
  const lines = config.paylines.length;

  return (rng, betCents) => {
    if (!Number.isInteger(betCents) || betCents <= 0) {
      throw new RangeError(`bet must be a positive whole number of cents, got ${betCents}`);
    }
    if (betCents % lines !== 0) {
      throw new RangeError(
        `bet of ${betCents} cents cannot be split evenly across ${lines} paylines`,
      );
    }
    const lineBet = betCents / lines;
    const outcome = engine(rng);
    const feature = outcome.freeSpins;
    return {
      betCents,
      winCents: outcome.winLineBets * lineBet,
      stops: outcome.base.stops,
      screen: outcome.base.screen,
      evaluation: outcome.base.evaluation,
      freeSpins: feature
        ? {
            multiplier: feature.multiplier,
            winCents: feature.winLineBets * lineBet,
            spins: feature.spins.map((s) => ({
              ...s,
              winCents: s.evaluation.winLineBets * feature.multiplier * lineBet,
            })),
          }
        : null,
    };
  };
}

/** Plays a single round. For many rounds, create the round player once and reuse it. */
export function playRound(config: GameConfig, rng: Rng, betCents: number): RoundResult {
  return createRoundPlayer(config)(rng, betCents);
}
