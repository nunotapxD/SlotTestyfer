/**
 * Monte Carlo simulation, sequential or across worker threads.
 *
 * The rounds are split into fixed-size chunks, and chunk i always uses seed deriveSeed(seed, i).
 * The chunks do not depend on how many workers run them, and the totals are exact integers, so
 * the same seed gives exactly the same report on a laptop with 4 cores or a server with 64.
 */
import { Worker } from 'node:worker_threads';
import { deriveSeed, type GameConfig } from '@slottestyfer/engine';
import { runChunk } from './chunk.js';
import { emptyStats, mergeStats, type SimStats } from './stats.js';

export const DEFAULT_CHUNK_SIZE = 250_000;

export interface Chunk {
  readonly index: number;
  readonly rounds: number;
  readonly seed: number;
}

export function planChunks(spins: number, seed: number, chunkSize = DEFAULT_CHUNK_SIZE): Chunk[] {
  if (!Number.isInteger(spins) || spins < 1) {
    throw new RangeError(`spins must be a positive integer, got ${spins}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const chunks: Chunk[] = [];
  for (let start = 0, index = 0; start < spins; start += chunkSize, index++) {
    chunks.push({
      index,
      rounds: Math.min(chunkSize, spins - start),
      seed: deriveSeed(seed, index),
    });
  }
  return chunks;
}

export interface SimulateOptions {
  readonly spins: number;
  readonly seed: number;
  /**
   * Worker threads to use. 0 (the default) runs in the current thread, which blocks it until
   * the simulation ends: fine for a CLI or a test, not for a server.
   */
  readonly workers?: number;
  readonly chunkSize?: number;
  /** Location of the compiled worker script. Defaults to worker.js next to this file. */
  readonly workerUrl?: URL;
  /** Called after each chunk with the rounds done so far. */
  readonly onProgress?: (roundsDone: number, roundsTotal: number) => void;
}

export async function simulate(config: GameConfig, options: SimulateOptions): Promise<SimStats> {
  const chunks = planChunks(options.spins, options.seed, options.chunkSize);
  const workers = Math.min(options.workers ?? 0, chunks.length);

  const results =
    workers < 1
      ? runSequential(config, chunks, options)
      : await runParallel(config, chunks, workers, options);

  return results.reduce(mergeStats, emptyStats(config.paylines.length));
}

function runSequential(
  config: GameConfig,
  chunks: readonly Chunk[],
  options: SimulateOptions,
): SimStats[] {
  let done = 0;
  return chunks.map((chunk) => {
    const stats = runChunk(config, chunk.rounds, chunk.seed);
    done += chunk.rounds;
    options.onProgress?.(done, options.spins);
    return stats;
  });
}

/** Messages exchanged with worker.ts. */
export interface ChunkJob {
  readonly index: number;
  readonly rounds: number;
  readonly seed: number;
}
export interface ChunkDone {
  readonly index: number;
  readonly stats: SimStats;
}

function runParallel(
  config: GameConfig,
  chunks: readonly Chunk[],
  workerCount: number,
  options: SimulateOptions,
): Promise<SimStats[]> {
  const workerUrl = options.workerUrl ?? new URL('./worker.js', import.meta.url);
  const results = new Array<SimStats | undefined>(chunks.length);
  const pending = [...chunks];
  const pool: Worker[] = [];
  let done = 0;
  let finished = 0;

  return new Promise((resolve, reject) => {
    const stopAll = () => Promise.all(pool.map((worker) => worker.terminate()));
    const fail = (error: unknown) => {
      void stopAll();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const giveWork = (worker: Worker) => {
      const chunk = pending.shift();
      if (chunk) {
        const job: ChunkJob = { index: chunk.index, rounds: chunk.rounds, seed: chunk.seed };
        worker.postMessage(job);
      }
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, { workerData: { config } });
      pool.push(worker);
      worker.on('error', fail);
      worker.on('message', (message: ChunkDone) => {
        results[message.index] = message.stats;
        done += chunks[message.index]?.rounds ?? 0;
        finished += 1;
        options.onProgress?.(done, options.spins);
        if (finished === chunks.length) {
          void stopAll().then(() => resolve(results.filter((r) => r !== undefined)));
        } else {
          giveWork(worker);
        }
      });
      giveWork(worker);
    }
  });
}
