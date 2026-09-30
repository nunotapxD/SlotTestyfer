import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGameConfig } from '@slottestyfer/engine';
import type { Report } from '@slottestyfer/simulator/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameFiles, seedGames } from '../src/games.js';
import { createSqliteStore } from '../src/sqlite-store.js';
import { GameExistsError, type Store } from '../src/store.js';

const gamesDir = new URL('../../../games/', import.meta.url);
const demo = parseGameConfig(
  JSON.parse(readFileSync(new URL('fruits-demo.json', gamesDir), 'utf8')),
);

const report = {
  rounds: 1000,
  rtp: 0.96,
  rtpBySymbol: [{ symbol: 'CHERRY', rtp: 0.5 }],
  hitFrequency: 0.3,
  maxWin: 44,
  stdDev: 2,
  standardError: 0.06,
  interval: { confidence: 0.95, low: 0.84, high: 1.08 },
  histogram: [{ label: '0x', rounds: 700, share: 0.7 }],
  rtpByFeature: { lines: 0.9, scatters: 0.06, freeSpins: 0, wildAssisted: 0.1 },
  featureFrequency: 0,
} satisfies Report;

/**
 * The same tests run against every Store implementation. PostgreSQL joins in when
 * TEST_DATABASE_URL is set (CI starts a postgres service for it), each run in its own schema.
 */
type Factory = (now: () => Date) => Promise<Store>;
const factories: [string, Factory][] = [
  ['sqlite', async (now) => createSqliteStore({ path: ':memory:', now })],
];
const postgresUrl = process.env['TEST_DATABASE_URL'];
if (postgresUrl) {
  factories.push([
    'postgres',
    async (now) => {
      const { createPostgresStore } = await import('../src/postgres-store.js');
      const schema = `test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      return createPostgresStore({
        connectionString: postgresUrl,
        schema,
        dropSchemaOnClose: true,
        now,
      });
    },
  ]);
}

describe.each(factories)('%s store', (_name, factory) => {
  let store: Store;
  let clock = 0;

  beforeEach(async () => {
    clock = 0;
    // A fixed clock that ticks one second per call, so ordering by time is predictable.
    store = await factory(() => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)));
  });

  afterEach(async () => {
    await store.close();
  });

  describe('games', () => {
    it('adds and reads back a game with its full config', async () => {
      const saved = await store.addGame(demo);
      expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(await store.getGame('fruits-demo')).toEqual(saved);
      expect((await store.getGame('fruits-demo'))?.config).toEqual(demo);
    });

    it('returns undefined for an unknown game', async () => {
      expect(await store.getGame('nope')).toBeUndefined();
    });

    it('refuses a second game with the same id', async () => {
      await store.addGame(demo);
      await expect(store.addGame(demo)).rejects.toThrow(GameExistsError);
    });

    it('lists games by id', async () => {
      await store.addGame({ ...demo, id: 'zeta' });
      await store.addGame({ ...demo, id: 'alpha' });
      expect((await store.listGames()).map((g) => g.id)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('simulations', () => {
    beforeEach(async () => {
      await store.addGame(demo);
    });

    const newSimulation = {
      gameId: 'fruits-demo',
      spins: 1000,
      seed: 4_294_967_295, // the largest seed must survive the database
      target: 0.96,
      tolerance: 0.005,
    };

    it('creates a queued simulation with an id', async () => {
      const sim = await store.createSimulation(newSimulation);
      expect(sim.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sim).toMatchObject({
        ...newSimulation,
        status: 'queued',
        roundsDone: 0,
        startedAt: null,
        finishedAt: null,
        report: null,
        verdict: null,
        error: null,
      });
      expect(await store.getSimulation(sim.id)).toEqual(sim);
    });

    it('keeps a null target', async () => {
      const sim = await store.createSimulation({ ...newSimulation, target: null });
      expect((await store.getSimulation(sim.id))?.target).toBeNull();
    });

    it('returns undefined for an unknown simulation', async () => {
      expect(await store.getSimulation('nope')).toBeUndefined();
    });

    it('refuses a simulation for a game that does not exist', async () => {
      await expect(store.createSimulation({ ...newSimulation, gameId: 'nope' })).rejects.toThrow();
    });

    it('moves through running and done, keeping the report and verdict', async () => {
      const { id } = await store.createSimulation(newSimulation);
      await store.markRunning(id);
      await store.updateProgress(id, 500);
      expect(await store.getSimulation(id)).toMatchObject({ status: 'running', roundsDone: 500 });

      const verdict = { status: 'PASS' as const, target: 0.96, tolerance: 0.005, reason: 'ok' };
      await store.markDone(id, report, verdict);
      const done = await store.getSimulation(id);
      expect(done).toMatchObject({ status: 'done', roundsDone: 1000, report, verdict });
      expect(done?.startedAt).not.toBeNull();
      expect(done?.finishedAt).not.toBeNull();
    });

    it('ignores progress for a simulation that is not running', async () => {
      const { id } = await store.createSimulation(newSimulation);
      await store.markRunning(id);
      await store.markDone(id, report, null);
      await store.updateProgress(id, 10);
      expect((await store.getSimulation(id))?.roundsDone).toBe(1000);
    });

    it('records failures', async () => {
      const { id } = await store.createSimulation(newSimulation);
      await store.markFailed(id, 'boom');
      expect(await store.getSimulation(id)).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('lists the most recent first and filters by game', async () => {
      await store.addGame({ ...demo, id: 'other' });
      const a = await store.createSimulation(newSimulation);
      const b = await store.createSimulation({ ...newSimulation, gameId: 'other' });
      const c = await store.createSimulation(newSimulation);
      expect((await store.listSimulations()).map((s) => s.id)).toEqual([c.id, b.id, a.id]);
      expect((await store.listSimulations({ gameId: 'fruits-demo' })).map((s) => s.id)).toEqual([
        c.id,
        a.id,
      ]);
      expect((await store.listSimulations({ limit: 1 })).map((s) => s.id)).toEqual([c.id]);
    });

    it('lists by status, oldest first', async () => {
      const a = await store.createSimulation(newSimulation);
      const b = await store.createSimulation(newSimulation);
      await store.markRunning(b.id);
      const c = await store.createSimulation(newSimulation);
      expect((await store.listSimulationsByStatus('queued')).map((s) => s.id)).toEqual([
        a.id,
        c.id,
      ]);
      expect((await store.listSimulationsByStatus('running')).map((s) => s.id)).toEqual([b.id]);
    });
  });
});

describe('game files', () => {
  it('loads every bundled game', () => {
    const ids = loadGameFiles(fileURLToPath(gamesDir)).map((g) => g.id);
    expect(ids).toEqual(
      expect.arrayContaining(['fruits-5x3', 'fruits-88', 'fruits-96', 'fruits-demo']),
    );
  });

  it('seeds only the games that are missing', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    expect(await seedGames(store, [demo])).toEqual(['fruits-demo']);
    expect(await seedGames(store, [demo])).toEqual([]);
    await store.close();
  });
});
