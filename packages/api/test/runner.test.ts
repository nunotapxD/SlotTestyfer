import { readFileSync } from 'node:fs';
import { parseGameConfig } from '@slottestyfer/engine';
import { analyzeExact } from '@slottestyfer/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunner, INTERRUPTED } from '../src/runner.js';
import { createSqliteStore, type Store } from '../src/store.js';

const load = (file: string) =>
  parseGameConfig(
    JSON.parse(readFileSync(new URL(`../../../games/${file}`, import.meta.url), 'utf8')),
  );

const fruits96 = load('fruits-96.json');

describe('simulation runner', () => {
  let store: Store;

  beforeEach(() => {
    store = createSqliteStore({ path: ':memory:' });
    store.addGame(fruits96);
  });

  afterEach(() => store.close());

  // workers: 0 runs in the test's own thread, so no compiled worker script is needed.
  const runner = () => createRunner({ store, workers: 0, chunkSize: 10_000 });

  it('runs a queued simulation and stores the report and verdict', async () => {
    const sim = store.createSimulation({
      gameId: 'fruits-96',
      spins: 200_000,
      seed: 42,
      target: 0.96,
      tolerance: 0.05,
    });
    const r = runner();
    r.enqueue(sim.id);
    await r.idle();

    const done = store.getSimulation(sim.id);
    expect(done?.status).toBe('done');
    expect(done?.roundsDone).toBe(200_000);
    expect(done?.report?.rounds).toBe(200_000);
    // Within 4 standard errors of the exact RTP (a 95% interval misses 1 run in 20 by design).
    const exact = analyzeExact(fruits96).report.rtp;
    const report = done?.report;
    expect(Math.abs((report?.rtp ?? 0) - exact)).toBeLessThan(4 * (report?.standardError ?? 0));
    expect(done?.verdict?.status).toBe('PASS');
  });

  it('gives the same report as any other run with the same seed', async () => {
    const a = store.createSimulation({
      gameId: 'fruits-96',
      spins: 30_000,
      seed: 7,
      target: null,
      tolerance: 0.005,
    });
    const b = store.createSimulation({
      gameId: 'fruits-96',
      spins: 30_000,
      seed: 7,
      target: null,
      tolerance: 0.005,
    });
    const r = runner();
    r.enqueue(a.id);
    r.enqueue(b.id);
    await r.idle();
    expect(store.getSimulation(a.id)?.report).toEqual(store.getSimulation(b.id)?.report);
    expect(store.getSimulation(a.id)?.verdict).toBeNull();
  });

  it('runs simulations one at a time, in order', async () => {
    const ids = [1, 2, 3].map(
      (seed) =>
        store.createSimulation({
          gameId: 'fruits-96',
          spins: 20_000,
          seed,
          target: null,
          tolerance: 0.005,
        }).id,
    );
    const r = runner();
    ids.forEach((id) => r.enqueue(id));
    await r.idle();
    const finished = ids.map((id) => store.getSimulation(id)?.finishedAt ?? '');
    expect(finished).toEqual([...finished].sort());
    expect(ids.map((id) => store.getSimulation(id)?.status)).toEqual(['done', 'done', 'done']);
  });

  it('ignores ids that are unknown or not queued', async () => {
    const sim = store.createSimulation({
      gameId: 'fruits-96',
      spins: 1000,
      seed: 1,
      target: null,
      tolerance: 0.005,
    });
    store.markFailed(sim.id, 'cancelled');
    const r = runner();
    r.enqueue('no-such-id');
    r.enqueue(sim.id);
    await r.idle();
    expect(store.getSimulation(sim.id)?.status).toBe('failed');
  });

  it('marks a simulation as failed when it throws', async () => {
    const sim = store.createSimulation({
      gameId: 'fruits-96',
      spins: 1000,
      seed: 1,
      target: 0.96,
      tolerance: 0.005,
    });
    // A worker script that does not exist makes the simulation fail.
    const r = createRunner({
      store,
      workers: 2,
      chunkSize: 100,
      workerUrl: new URL('file:///no/such/worker.js'),
    });
    r.enqueue(sim.id);
    await r.idle();
    const failed = store.getSimulation(sim.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBeTruthy();
  });

  it('recovers after a restart: running ones failed, queued ones run', async () => {
    const interrupted = store.createSimulation({
      gameId: 'fruits-96',
      spins: 1000,
      seed: 1,
      target: null,
      tolerance: 0.005,
    });
    store.markRunning(interrupted.id);
    const waiting = store.createSimulation({
      gameId: 'fruits-96',
      spins: 1000,
      seed: 2,
      target: null,
      tolerance: 0.005,
    });

    const r = runner();
    r.recover();
    await r.idle();

    expect(store.getSimulation(interrupted.id)).toMatchObject({
      status: 'failed',
      error: INTERRUPTED,
    });
    expect(store.getSimulation(waiting.id)?.status).toBe('done');
  });

  it('takes no more work after stop', async () => {
    const sim = store.createSimulation({
      gameId: 'fruits-96',
      spins: 1000,
      seed: 1,
      target: null,
      tolerance: 0.005,
    });
    const r = runner();
    r.stop();
    r.enqueue(sim.id);
    await r.idle();
    expect(store.getSimulation(sim.id)?.status).toBe('queued');
  });
});
