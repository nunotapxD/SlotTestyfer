import { readFileSync } from 'node:fs';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { describe, expect, it } from 'vitest';
import { runLiveLoop, TICK_MS, type LiveCommand, type LiveEvent } from '../src/live/loop.js';
import { LiveManager, TooManyLiveRunsError, type LiveMessage } from '../src/live/manager.js';
import { LiveRun, streakAlarm, type LiveSettings } from '../src/live/run.js';

const load = (file: string): GameConfig =>
  parseGameConfig(
    JSON.parse(readFileSync(new URL(`../../../games/${file}.json`, import.meta.url), 'utf8')),
  );

const fruits96 = load('fruits-96');
const fruits88 = load('fruits-88');

const settings = (overrides: Partial<LiveSettings> = {}): LiveSettings => ({
  seed: 42,
  target: 0.96,
  tolerance: 0.005,
  players: 3,
  playerRoundsPerTick: 2,
  startBalance: 100,
  roundsPerSecond: 10_000,
  maxRounds: 5000,
  ...overrides,
});

/**
 * Runs the loop with a fake clock: every sleep moves time forward and returns at once, so ticks
 * are instant and deterministic. `script` can send commands after each event.
 */
async function drive(
  game: GameConfig,
  s: LiveSettings,
  script: (event: LiveEvent, send: (c: LiveCommand) => void, events: LiveEvent[]) => void = () =>
    undefined,
  onSleep: (sleeps: number, send: (c: LiveCommand) => void) => void = () => undefined,
): Promise<LiveEvent[]> {
  const events: LiveEvent[] = [];
  let handler: (c: LiveCommand) => void = () => undefined;
  let clock = 0;
  let sleeps = 0;
  await runLiveLoop(game, s, {
    onCommand: (h) => {
      handler = h;
    },
    emit: (event) => {
      events.push(event);
      script(event, (c) => handler(c), events);
    },
    now: () => clock,
    sleep: async () => {
      clock += TICK_MS;
      sleeps++;
      onSleep(sleeps, (c) => handler(c));
    },
  });
  return events;
}

const batches = (events: LiveEvent[]) =>
  events.flatMap((e) => (e.type === 'batch' ? [e.batch] : []));

describe('LiveRun', () => {
  it('plays up to the round limit and numbers batches', () => {
    const run = new LiveRun(fruits96, settings({ maxRounds: 1500 }));
    expect(run.batch()).toBeNull();
    expect(run.playRounds(1000)).toBe(1000);
    expect(run.playRounds(1000)).toBe(500);
    expect(run.finished).toBe(true);
    expect(run.batch()?.seq).toBe(1);
    expect(run.batch()?.seq).toBe(2);
  });

  it('is reproducible from the seed', () => {
    const a = new LiveRun(fruits96, settings());
    const b = new LiveRun(fruits96, settings());
    a.playRounds(3000);
    b.playRounds(3000);
    a.playPlayers();
    b.playPlayers();
    expect(a.batch()).toEqual(b.batch());
  });

  it('starts every virtual player with 100 credits and bets 1 per round', () => {
    const run = new LiveRun(fruits96, settings({ players: 4, playerRoundsPerTick: 0 }));
    run.playRounds(1);
    expect(run.batch()?.players.map((p) => p.balance)).toEqual([100, 100, 100, 100]);
  });

  it('raises one alert when the RTP is clearly outside the range', () => {
    const run = new LiveRun(fruits88, settings({ maxRounds: 1_000_000 }));
    const alerts = [];
    for (let i = 0; i < 20; i++) {
      run.playRounds(25_000);
      alerts.push(...(run.batch()?.alerts ?? []));
    }
    const outOfRange = alerts.filter((a) => a.kind === 'rtp-out-of-range');
    expect(outOfRange).toHaveLength(1);
    expect(run.batch()?.verdict).toEqual({ status: 'FAIL', final: true });
  });

  it('knows which losing streaks are unusual', () => {
    expect(streakAlarm(0.5, 100)).toBe(13);
    expect(streakAlarm(0, 100)).toBe(Infinity);
  });
});

describe('live loop', () => {
  it('emits numbered batches at the chosen speed until the limit', async () => {
    const events = await drive(fruits96, settings({ roundsPerSecond: 10_000, maxRounds: 5000 }));
    const list = batches(events);
    // 10,000 rounds/s x 0.1 s = 1000 rounds per tick.
    expect(list.map((b) => b.rounds)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(list.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[events.length - 1]).toEqual({ type: 'end', reason: 'finished' });
  });

  it('pauses and resumes', async () => {
    let paused = false;
    const events = await drive(
      fruits96,
      settings({ maxRounds: 4000 }),
      (event, send) => {
        if (event.type === 'batch' && event.batch.seq === 2 && !paused) {
          paused = true;
          send({ type: 'pause' });
        }
      },
      (sleeps, send) => {
        if (sleeps === 6) send({ type: 'resume' });
      },
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual(['batch', 'batch', 'paused', 'resumed', 'batch', 'batch', 'end']);
    expect(batches(events).map((b) => b.rounds)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('cancels', async () => {
    const events = await drive(fruits96, settings({ maxRounds: 1_000_000 }), (event, send) => {
      if (event.type === 'batch' && event.batch.seq === 3) send({ type: 'cancel' });
    });
    expect(batches(events)).toHaveLength(3);
    expect(events[events.length - 1]).toEqual({ type: 'end', reason: 'cancelled' });
  });

  it('changes speed', async () => {
    const events = await drive(fruits96, settings({ maxRounds: 6000 }), (event, send) => {
      if (event.type === 'batch' && event.batch.seq === 2) {
        send({ type: 'speed', roundsPerSecond: 20_000 });
      }
    });
    expect(batches(events).map((b) => b.rounds)).toEqual([1000, 2000, 4000, 6000]);
  });
});

describe('live manager (main thread)', () => {
  it('fans batches out to subscribers in order and keeps a history', async () => {
    const manager = new LiveManager({ inline: true });
    const run = manager.start(fruits96, settings({ roundsPerSecond: 0, maxRounds: 30_000 }));
    const messages: LiveMessage[] = [];
    await new Promise<void>((resolve) => {
      run.subscribe((m) => {
        messages.push(m);
        if (m.type === 'status' && run.done) resolve();
      });
    });
    const seqs = messages.map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(messages[messages.length - 1]).toMatchObject({
      type: 'status',
      data: { status: 'finished' },
    });
    const snapshot = run.snapshot();
    expect(snapshot.last?.rounds).toBe(30_000);
    expect(snapshot.history.length).toBeGreaterThan(0);
    expect(manager.list().map((s) => s.id)).toEqual([run.id]);
    await manager.close();
  });

  it('limits how many runs are active at once', async () => {
    const manager = new LiveManager({ inline: true, maxActive: 1 });
    const first = manager.start(fruits96, settings({ roundsPerSecond: 1000, maxRounds: 1e9 }));
    expect(() => manager.start(fruits96, settings())).toThrow(TooManyLiveRunsError);
    first.command({ type: 'cancel' });
    await new Promise<void>((resolve) => {
      first.subscribe(() => {
        if (first.done) resolve();
      });
    });
    expect(first.status).toBe('cancelled');
    await manager.close();
  });
});
