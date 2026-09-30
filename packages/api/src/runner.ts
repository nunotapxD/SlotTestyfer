/**
 * Runs simulations in the background, one at a time, in the order they were requested.
 *
 * A request only creates a 'queued' row and returns its id straight away. The runner picks it
 * up, uses every worker thread for it, saves progress after each chunk and stores the report.
 * One at a time keeps each simulation fast and makes the queue easy to reason about.
 */
import { certify, simulate, summarize, type SimulateOptions } from '@slottestyfer/simulator';
import type { Store } from './store.js';

export interface RunnerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RunnerOptions {
  readonly store: Store;
  /**
   * Worker threads per simulation. Use at least 1 in the server so the API keeps answering while
   * a simulation runs; 0 runs it in the main thread, which is only for tests.
   */
  readonly workers: number;
  readonly chunkSize?: number;
  readonly workerUrl?: URL;
  readonly logger?: RunnerLogger;
}

export interface SimulationRunner {
  /** Adds a queued simulation to the queue and starts working if idle. */
  enqueue(id: string): void;
  /**
   * Called once on startup. Simulations left 'running' by a previous process are marked as
   * failed; the ones still 'queued' are put back in the queue.
   */
  recover(): Promise<void>;
  /** Resolves when the queue is empty and nothing is running. */
  idle(): Promise<void>;
  /** Stops taking new work. A simulation in progress is left to finish or be recovered. */
  stop(): void;
}

export const INTERRUPTED = 'interrupted: the server stopped before the simulation finished';

export function createRunner(options: RunnerOptions): SimulationRunner {
  const { store, logger } = options;
  const queue: string[] = [];
  let current: Promise<void> | null = null;
  let stopped = false;

  const run = async (id: string): Promise<void> => {
    const simulation = await store.getSimulation(id);
    if (!simulation || simulation.status !== 'queued') return;

    const game = await store.getGame(simulation.gameId);
    if (!game) {
      await store.markFailed(id, `game ${simulation.gameId} no longer exists`);
      return;
    }

    await store.markRunning(id);
    logger?.info(`simulation ${id}: ${simulation.spins} rounds of ${game.id}`);

    // Progress arrives synchronously after each chunk; the writes are chained so they reach the
    // database in order and all land before the final result.
    let progress: Promise<void> = Promise.resolve();
    const simulateOptions: SimulateOptions = {
      spins: simulation.spins,
      seed: simulation.seed,
      workers: options.workers,
      onProgress: (done) => {
        progress = progress.then(() => store.updateProgress(id, done)).catch(() => undefined);
      },
      ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
      ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
    };

    try {
      const report = summarize(await simulate(game.config, simulateOptions));
      const verdict =
        simulation.target === null
          ? null
          : certify(report, simulation.target, simulation.tolerance);
      await progress;
      await store.markDone(id, report, verdict);
      logger?.info(`simulation ${id}: done, RTP ${(report.rtp * 100).toFixed(3)}%`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await progress;
      await store.markFailed(id, message);
      logger?.error(`simulation ${id}: failed, ${message}`);
    }
  };

  const drain = async (): Promise<void> => {
    // Start on a later turn of the event loop, so the request that queued the simulation gets
    // its 202 response before any work begins.
    await new Promise((resolve) => setImmediate(resolve));
    let next = queue.shift();
    while (next !== undefined && !stopped) {
      await run(next);
      next = queue.shift();
    }
  };

  const wake = () => {
    if (current || stopped) return;
    current = drain().finally(() => {
      current = null;
      // Something may have been queued while the last run was finishing.
      if (queue.length > 0) wake();
    });
  };

  const enqueue = (id: string) => {
    if (stopped) return;
    queue.push(id);
    wake();
  };

  return {
    enqueue,

    async recover() {
      for (const simulation of await store.listSimulationsByStatus('running')) {
        await store.markFailed(simulation.id, INTERRUPTED);
      }
      for (const simulation of await store.listSimulationsByStatus('queued')) {
        enqueue(simulation.id);
      }
    },

    async idle() {
      while (current) await current;
    },

    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
