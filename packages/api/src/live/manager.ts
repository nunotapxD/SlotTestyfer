/**
 * Keeps track of live runs: starts each one in its own worker thread, forwards commands, keeps a
 * short history for clients that connect late, and fans batches out to every subscriber (the
 * Server-Sent Events connections).
 */
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { GameConfig } from '@slottestyfer/engine';
import { runLiveLoop, type LiveCommand, type LiveEvent } from './loop.js';
import type { LiveAlert, LiveBatch, LiveSettings } from './run.js';

export type LiveStatus = 'running' | 'paused' | 'finished' | 'cancelled' | 'failed';

export interface HistoryPoint {
  readonly rounds: number;
  readonly rtp: number;
  readonly low: number;
  readonly high: number;
  /** Balance of each virtual player at this point, in credits. */
  readonly players: readonly number[];
  /** Rounds each virtual player still in the game has played so far. */
  readonly playerRounds: number;
}

export interface LiveState {
  readonly id: string;
  readonly game: { readonly id: string; readonly name: string };
  readonly settings: LiveSettings;
  readonly status: LiveStatus;
  readonly startedAt: string;
  readonly last: (LiveBatch & { readonly roundsPerSecond: number }) | null;
  readonly error: string | null;
}

export interface LiveSnapshot extends LiveState {
  readonly history: readonly HistoryPoint[];
  readonly alerts: readonly LiveAlert[];
}

/** What subscribers receive. `seq` increases by 1 per message, across all message types. */
export type LiveMessage =
  | { readonly seq: number; readonly type: 'batch'; readonly data: LiveState['last'] }
  | {
      readonly seq: number;
      readonly type: 'status';
      readonly data: { readonly status: LiveStatus; readonly error: string | null };
    };

type Listener = (message: LiveMessage) => void;

const HISTORY_LIMIT = 400;
const KEEP_FINISHED_MS = 10 * 60_000;

export class LiveRunHandle {
  readonly id = randomUUID();
  private state: LiveState;
  private readonly history: HistoryPoint[] = [];
  private readonly alerts: LiveAlert[] = [];
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private send: (command: LiveCommand) => void = () => undefined;

  constructor(game: GameConfig, settings: LiveSettings) {
    this.state = {
      id: this.id,
      game: { id: game.id, name: game.name },
      settings,
      status: 'running',
      startedAt: new Date().toISOString(),
      last: null,
      error: null,
    };
  }

  get status(): LiveStatus {
    return this.state.status;
  }

  get done(): boolean {
    return ['finished', 'cancelled', 'failed'].includes(this.state.status);
  }

  view(): LiveState {
    return this.state;
  }

  snapshot(): LiveSnapshot {
    return { ...this.state, history: [...this.history], alerts: [...this.alerts] };
  }

  /** Connects the handle to whatever runs the loop. */
  attach(send: (command: LiveCommand) => void): void {
    this.send = send;
  }

  command(command: LiveCommand): void {
    if (this.done) return;
    if (command.type === 'speed') {
      this.state = {
        ...this.state,
        settings: { ...this.state.settings, roundsPerSecond: command.roundsPerSecond },
      };
    }
    this.send(command);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(message: Omit<LiveMessage, 'seq'>): void {
    this.seq += 1;
    const full = { ...message, seq: this.seq } as LiveMessage;
    for (const listener of this.listeners) listener(full);
  }

  private setStatus(status: LiveStatus, error: string | null = null): void {
    this.state = { ...this.state, status, error };
    this.publish({ type: 'status', data: { status, error } });
  }

  /** Called with every event from the loop. */
  handle(event: LiveEvent): void {
    if (event.type === 'batch') {
      const last = { ...event.batch, roundsPerSecond: event.roundsPerSecond };
      this.state = { ...this.state, last };
      this.alerts.push(...event.batch.alerts);
      this.history.push({
        rounds: last.rounds,
        rtp: last.rtp,
        low: last.low,
        high: last.high,
        players: last.players.map((p) => p.balance),
        playerRounds: Math.max(0, ...last.players.map((p) => p.rounds)),
      });
      // Keep the history short: drop every other point, keeping the first and the latest.
      if (this.history.length > HISTORY_LIMIT) {
        const thinned = this.history.filter((_, i) => i % 2 === 0 || i === this.history.length - 1);
        this.history.splice(0, this.history.length, ...thinned);
      }
      this.publish({ type: 'batch', data: last });
    } else if (event.type === 'paused') {
      this.setStatus('paused');
    } else if (event.type === 'resumed') {
      this.setStatus('running');
    } else {
      this.setStatus(event.reason, event.message ?? null);
    }
  }
}

export interface LiveManagerOptions {
  /**
   * Run each live simulation in a worker thread (the server) or in the main thread (tests,
   * where the compiled worker may not exist).
   */
  readonly inline?: boolean;
  /** Location of the compiled worker. Defaults to worker.js next to this file. */
  readonly workerUrl?: URL;
  /** Most runs active at the same time. Default 4. */
  readonly maxActive?: number;
}

export class TooManyLiveRunsError extends Error {
  constructor(max: number) {
    super(`at most ${max} live runs can be active at the same time; cancel one first`);
    this.name = 'TooManyLiveRunsError';
  }
}

export class LiveManager {
  private readonly runs = new Map<string, LiveRunHandle>();
  private readonly workers = new Set<Worker>();
  private readonly options: LiveManagerOptions;

  constructor(options: LiveManagerOptions = {}) {
    this.options = options;
  }

  get(id: string): LiveRunHandle | undefined {
    return this.runs.get(id);
  }

  list(): LiveState[] {
    return [...this.runs.values()].map((run) => run.view());
  }

  start(config: GameConfig, settings: LiveSettings): LiveRunHandle {
    const max = this.options.maxActive ?? 4;
    const active = [...this.runs.values()].filter((run) => !run.done).length;
    if (active >= max) throw new TooManyLiveRunsError(max);

    const handle = new LiveRunHandle(config, settings);
    this.runs.set(handle.id, handle);
    const finish = () => {
      const timer = setTimeout(() => this.runs.delete(handle.id), KEEP_FINISHED_MS);
      timer.unref();
    };

    if (this.options.inline) {
      // Commands sent before the loop has started are kept and delivered when it does.
      let handler: ((command: LiveCommand) => void) | null = null;
      const pending: LiveCommand[] = [];
      handle.attach((command) => (handler ? handler(command) : pending.push(command)));
      // Start on the next turn of the event loop, so whoever started the run can subscribe first
      // (a worker thread gives the same guarantee naturally).
      setImmediate(() => {
        void runLiveLoop(config, settings, {
          onCommand: (h) => {
            handler = h;
            for (const command of pending.splice(0)) h(command);
          },
          emit: (event) => handle.handle(event),
          now: () => performance.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }).then(finish);
      });
    } else {
      const url = this.options.workerUrl ?? new URL('./worker.js', import.meta.url);
      const worker = new Worker(url, { workerData: { config, settings } });
      this.workers.add(worker);
      handle.attach((command) => worker.postMessage(command));
      worker.on('message', (event: LiveEvent) => handle.handle(event));
      worker.on('error', (error) => {
        if (!handle.done) handle.handle({ type: 'end', reason: 'failed', message: error.message });
      });
      worker.on('exit', () => {
        this.workers.delete(worker);
        if (!handle.done)
          handle.handle({ type: 'end', reason: 'failed', message: 'worker stopped' });
        finish();
      });
    }
    return handle;
  }

  /** Cancels everything; used when the server shuts down. */
  async close(): Promise<void> {
    for (const run of this.runs.values()) run.command({ type: 'cancel' });
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
  }
}
