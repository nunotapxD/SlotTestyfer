/**
 * One complete round: validate the bet, spin, evaluate and pay in whole cents.
 * Credits are fictional; this engine never handles real money.
 */
import type { GameConfig } from './config.js';
import { createEvaluator, type Evaluation } from './evaluate.js';
import type { Rng } from './rng.js';
import { spin, type Screen } from './spin.js';

export interface RoundResult {
  readonly betCents: number;
  readonly winCents: number;
  readonly stops: readonly number[];
  readonly screen: Screen;
  readonly evaluation: Evaluation;
}

export type RoundPlayer = (rng: Rng, betCents: number) => RoundResult;

/** Prepares a game once and returns a function that plays rounds. */
export function createRoundPlayer(config: GameConfig): RoundPlayer {
  const evaluator = createEvaluator(config);
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
    const { stops, screen } = spin(config, rng);
    const evaluation = evaluator(screen);
    const winCents = evaluation.winLineBets * (betCents / lines);
    return { betCents, winCents, stops, screen, evaluation };
  };
}

/** Plays a single round. For many rounds, create the round player once and reuse it. */
export function playRound(config: GameConfig, rng: Rng, betCents: number): RoundResult {
  return createRoundPlayer(config)(rng, betCents);
}
