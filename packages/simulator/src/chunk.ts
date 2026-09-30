/**
 * Runs a block of rounds in the current thread. The building block for both the sequential
 * and the parallel simulation.
 */
import { createEvaluator, createRng, spin, type GameConfig } from '@slottestyfer/engine';
import { emptyStats, recordRound, type SimStats } from './stats.js';

export function runChunk(config: GameConfig, rounds: number, seed: number): SimStats {
  const rng = createRng(seed);
  const evaluator = createEvaluator(config);
  const stats = emptyStats(config.paylines.length);
  for (let i = 0; i < rounds; i++) {
    recordRound(stats, evaluator(spin(config, rng).screen));
  }
  return stats;
}
