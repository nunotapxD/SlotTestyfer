/**
 * Runs a block of rounds in the current thread. The building block for both the sequential
 * and the parallel simulation.
 */
import { createRng, createRoundEngine, type GameConfig } from '@slottestyfer/engine';
import { emptyStats, recordRound, type SimStats } from './stats.js';

export function runChunk(config: GameConfig, rounds: number, seed: number): SimStats {
  const rng = createRng(seed);
  const play = createRoundEngine(config);
  const stats = emptyStats(config.paylines.length);
  for (let i = 0; i < rounds; i++) {
    recordRound(stats, play(rng));
  }
  return stats;
}
