import { readFileSync } from 'node:fs';
import { parseGameConfig } from '@slottestyfer/engine';
import { computeRtp } from '@slottestyfer/simulator/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunner, INTERRUPTED } from '../src/runner.js';
import { createSqliteStore } from '../src/sqlite-store.js';
import type { Store } from '../src/store.js';

const load = (file: string) =>
  parseGameConfig(
    JSON.parse(readFileSync(new URL(`../../../games/${file}`, import.meta.url), 'utf8')),
  );

const fruits96 = load('fruits-96.json');

const newSim = (seed: number, spins = 1000, target: number | null = null) => ({
  gameId: 'fruits-96',
  spins,
  seed,
  target,
  tolerance: 0.005,
});

describe('simulation runner', () => {
  let store: Store;

  beforeEach(async () => {
    store = createSqliteStore({ path: ':memory:' });
    await store.addGame(fruits96);
  });

  afterEach(async () => {
    await store.close();
  });

  // workers: 0 runs in the test's own thread, so no compiled worker script is needed.
  const runner = () => createRunner({ store, workers: 0, chunkSize: 10_000 });

  it('runs a queued simulation and stores the report and verdict', async () => {
    const sim = await store.createSimulation({ ...newSim(42, 200_000, 0.96), tolerance: 0.05 });
    const r = runner();
    r.enqueue(sim.id);
    await r.idle();

    const done = await store.getSimulation(sim.id);
    expect(done?.status).toBe('done');
    expect(done?.roundsDone).toBe(200_000);
    expect(done?.report?.rounds).toBe(200_000);
    // Within 4 standard errors of the exact RTP (a 95% interval misses 1 run in 20 by design).
    const exact = computeRtp(fruits96).rtp;
    const report = done?.report;
    expect(Math.abs((report?.rtp ?? 0) - exact)).toBeLessThan(4 * (report?.standardError ?? 0));
    expect(done?.verdict?.status).toBe('PASS');
  });

  it('gives the same report as any other run with the same seed', async () => {
    const a = await store.createSimulation(newSim(7, 30_000));
    const b = await store.createSimulation(newSim(7, 30_000));
    const r = runner();
    r.enqueue(a.id);
    r.enqueue(b.id);
    await r.idle();
    expect((await store.getSimulation(a.id))?.report).toEqual(
      (await store.getSimulation(b.id))?.report,
    );
    expect((await store.getSimulation(a.id))?.verdict).toBeNull();
  });

  it('runs simulations one at a time, in order', async () => {
    const ids: string[] = [];
    for (const seed of [1, 2, 3]) ids.push((await store.createSimulation(newSim(seed, 20_000))).id);
    const r = runner();
    ids.forEach((id) => r.enqueue(id));
    await r.idle();
    const sims = await Promise.all(ids.map((id) => store.getSimulation(id)));
    const finished = sims.map((s) => s?.finishedAt ?? '');
    expect(finished).toEqual([...finished].sort());
    expect(sims.map((s) => s?.status)).toEqual(['done', 'done', 'done']);
  });

  it('ignores ids that are unknown or not queued', async () => {
    const sim = await store.createSimulation(newSim(1));
    await store.markFailed(sim.id, 'cancelled');
    const r = runner();
    r.enqueue('no-such-id');
    r.enqueue(sim.id);
    await r.idle();
    expect((await store.getSimulation(sim.id))?.status).toBe('failed');
  });

  it('marks a simulation as failed when it throws', async () => {
    const sim = await store.createSimulation(newSim(1, 1000, 0.96));
    // A worker script that does not exist makes the simulation fail.
    const r = createRunner({
      store,
      workers: 2,
      chunkSize: 100,
      workerUrl: new URL('file:///no/such/worker.js'),
    });
    r.enqueue(sim.id);
    await r.idle();
    const failed = await store.getSimulation(sim.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBeTruthy();
  });

  it('recovers after a restart: running ones failed, queued ones run', async () => {
    const interrupted = await store.createSimulation(newSim(1));
    await store.markRunning(interrupted.id);
    const waiting = await store.createSimulation(newSim(2));

    const r = runner();
    await r.recover();
    await r.idle();

    expect(await store.getSimulation(interrupted.id)).toMatchObject({
      status: 'failed',
      error: INTERRUPTED,
    });
    expect((await store.getSimulation(waiting.id))?.status).toBe('done');
  });

  it('takes no more work after stop', async () => {
    const sim = await store.createSimulation(newSim(1));
    const r = runner();
    r.stop();
    r.enqueue(sim.id);
    await r.idle();
    expect((await store.getSimulation(sim.id))?.status).toBe('queued');
  });
});
