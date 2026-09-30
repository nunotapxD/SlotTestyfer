/**
 * Rounds kept one by one for detailed analysis. The simulator only keeps totals (it may run
 * billions of rounds); here we keep a sample, e.g. 100,000 rounds, which is enough for
 * percentiles, streaks and drawdowns and small enough for memory (0.8 MB).
 */
import { createRng, createRoundEngine, type GameConfig } from '@slottestyfer/engine';
import { emptyStats, recordRound, type SimStats } from '@slottestyfer/simulator/core';

export interface RoundSample {
  readonly gameId: string;
  readonly seed: number;
  /** Win of each round, as a multiple of the total bet. */
  readonly wins: Float64Array;
  /** 1 when the round triggered free spins. */
  readonly triggered: Uint8Array;
  /** The same rounds as simulator totals, for the RTP breakdown. */
  readonly stats: SimStats;
}

export function sampleRounds(
  config: GameConfig,
  rounds: number,
  seed: number,
  onProgress?: (done: number) => void,
): RoundSample {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RangeError(`rounds must be a positive integer, got ${rounds}`);
  }
  const rng = createRng(seed);
  const play = createRoundEngine(config);
  const stats = emptyStats(config.paylines.length);
  const wins = new Float64Array(rounds);
  const triggered = new Uint8Array(rounds);

  for (let i = 0; i < rounds; i++) {
    const outcome = play(rng);
    recordRound(stats, outcome);
    wins[i] = outcome.multiplier;
    triggered[i] = outcome.freeSpins ? 1 : 0;
    if (onProgress && (i + 1) % 10_000 === 0) onProgress(i + 1);
  }
  return { gameId: config.id, seed, wins, triggered, stats };
}
