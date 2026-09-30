/**
 * The clock of a live run: every tick (100 ms) it plays the rounds due at the chosen speed, lets
 * the virtual players play, and emits one batch. Pause, resume, cancel and speed changes arrive
 * as commands between ticks.
 *
 * The same loop runs inside a worker thread (worker.ts) in the server, and in the main thread in
 * tests; only the way commands arrive and batches leave differs.
 */
import type { GameConfig } from '@slottestyfer/engine';
import { LiveRun, type LiveBatch, type LiveSettings } from './run.js';

export const TICK_MS = 100;

export type LiveCommand =
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'cancel' }
  | { readonly type: 'speed'; readonly roundsPerSecond: number };

export type LiveEvent =
  | { readonly type: 'batch'; readonly batch: LiveBatch; readonly roundsPerSecond: number }
  | { readonly type: 'paused' }
  | { readonly type: 'resumed' }
  | {
      readonly type: 'end';
      readonly reason: 'finished' | 'cancelled' | 'failed';
      readonly message?: string;
    };

export interface LoopIo {
  /** Registers the handler for commands. */
  onCommand(handler: (command: LiveCommand) => void): void;
  emit(event: LiveEvent): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export async function runLiveLoop(
  config: GameConfig,
  settings: LiveSettings,
  io: LoopIo,
): Promise<void> {
  const run = new LiveRun(config, settings);
  let paused = false;
  let cancelled = false;
  let speed = settings.roundsPerSecond;
  let carry = 0; // fractional rounds owed at low speeds

  io.onCommand((command) => {
    if (command.type === 'pause' && !paused) {
      paused = true;
      io.emit({ type: 'paused' });
    } else if (command.type === 'resume' && paused) {
      paused = false;
      io.emit({ type: 'resumed' });
    } else if (command.type === 'cancel') {
      cancelled = true;
    } else if (command.type === 'speed') {
      speed = Math.max(0, command.roundsPerSecond);
    }
  });

  try {
    while (!cancelled && !run.finished) {
      const tickStart = io.now();
      if (!paused) {
        const before = run.rounds;
        if (speed > 0) {
          const due = (speed * TICK_MS) / 1000 + carry;
          const whole = Math.floor(due);
          carry = due - whole;
          run.playRounds(whole);
        } else {
          // As fast as possible, leaving part of the tick free so commands get through.
          while (!run.finished && io.now() - tickStart < TICK_MS * 0.8) run.playRounds(2000);
        }
        run.playPlayers();
        const batch = run.batch();
        const elapsed = Math.max(1, io.now() - tickStart);
        if (batch) {
          const played = run.rounds - before;
          const roundsPerSecond =
            speed > 0 ? Math.min(speed, (played * 1000) / TICK_MS) : (played * 1000) / elapsed;
          io.emit({ type: 'batch', batch, roundsPerSecond: Math.round(roundsPerSecond) });
        }
      }
      await io.sleep(Math.max(0, TICK_MS - (io.now() - tickStart)));
    }
    io.emit({ type: 'end', reason: cancelled ? 'cancelled' : 'finished' });
  } catch (error) {
    io.emit({
      type: 'end',
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
