import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGameConfig } from '@slottestyfer/engine';
import type { Report } from '@slottestyfer/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameFiles, seedGames } from '../src/games.js';
import { createSqliteStore, GameExistsError, type Store } from '../src/store.js';

const gamesDir = new URL('../../../games/', import.meta.url);
const demo = parseGameConfig(
  JSON.parse(readFileSync(new URL('fruits-demo.json', gamesDir), 'utf8')),
);

const report: Report = {
  rounds: 1000,
  rtp: 0.96,
  rtpBySymbol: [{ symbol: 'CHERRY', rtp: 0.5 }],
  hitFrequency: 0.3,
  maxWin: 44,
  stdDev: 2,
  standardError: 0.06,
  interval: { confidence: 0.95, low: 0.84, high: 1.08 },
  histogram: [{ label: '0x', rounds: 700, share: 0.7 }],
};

describe('sqlite store', () => {
  let store: Store;
  let clock = 0;

  beforeEach(() => {
    clock = 0;
    // A fixed clock that ticks one second per call, so ordering by time is predictable.
    store = createSqliteStore({
      path: ':memory:',
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    });
  });

  afterEach(() => store.close());

  describe('games', () => {
    it('adds and reads back a game with its full config', () => {
      const saved = store.addGame(demo);
      expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(store.getGame('fruits-demo')).toEqual(saved);
      expect(store.getGame('fruits-demo')?.config).toEqual(demo);
    });

    it('returns undefined for an unknown game', () => {
      expect(store.getGame('nope')).toBeUndefined();
    });

    it('refuses a second game with the same id', () => {
      store.addGame(demo);
      expect(() => store.addGame(demo)).toThrow(GameExistsError);
    });

    it('lists games by id', () => {
      store.addGame({ ...demo, id: 'zeta' });
      store.addGame({ ...demo, id: 'alpha' });
      expect(store.listGames().map((g) => g.id)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('simulations', () => {
    beforeEach(() => {
      store.addGame(demo);
    });

    const newSimulation = {
      gameId: 'fruits-demo',
      spins: 1000,
      seed: 42,
      target: 0.96,
      tolerance: 0.005,
    };

    it('creates a queued simulation with an id', () => {
      const sim = store.createSimulation(newSimulation);
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
      expect(store.getSimulation(sim.id)).toEqual(sim);
    });

    it('keeps a null target', () => {
      const sim = store.createSimulation({ ...newSimulation, target: null });
      expect(store.getSimulation(sim.id)?.target).toBeNull();
    });

    it('refuses a simulation for a game that does not exist', () => {
      expect(() => store.createSimulation({ ...newSimulation, gameId: 'nope' })).toThrow();
    });

    it('moves through running and done, keeping the report and verdict', () => {
      const { id } = store.createSimulation(newSimulation);
      store.markRunning(id);
      store.updateProgress(id, 500);
      expect(store.getSimulation(id)).toMatchObject({ status: 'running', roundsDone: 500 });

      const verdict = { status: 'PASS' as const, target: 0.96, tolerance: 0.005, reason: 'ok' };
      store.markDone(id, report, verdict);
      const done = store.getSimulation(id);
      expect(done).toMatchObject({ status: 'done', roundsDone: 1000, report, verdict });
      expect(done?.startedAt).not.toBeNull();
      expect(done?.finishedAt).not.toBeNull();
    });

    it('records failures', () => {
      const { id } = store.createSimulation(newSimulation);
      store.markFailed(id, 'boom');
      expect(store.getSimulation(id)).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('lists the most recent first and filters by game', () => {
      store.addGame({ ...demo, id: 'other' });
      const a = store.createSimulation(newSimulation);
      const b = store.createSimulation({ ...newSimulation, gameId: 'other' });
      const c = store.createSimulation(newSimulation);
      expect(store.listSimulations().map((s) => s.id)).toEqual([c.id, b.id, a.id]);
      expect(store.listSimulations({ gameId: 'fruits-demo' }).map((s) => s.id)).toEqual([
        c.id,
        a.id,
      ]);
      expect(store.listSimulations({ limit: 1 }).map((s) => s.id)).toEqual([c.id]);
    });

    it('lists by status, oldest first', () => {
      const a = store.createSimulation(newSimulation);
      const b = store.createSimulation(newSimulation);
      store.markRunning(b.id);
      const c = store.createSimulation(newSimulation);
      expect(store.listSimulationsByStatus('queued').map((s) => s.id)).toEqual([a.id, c.id]);
      expect(store.listSimulationsByStatus('running').map((s) => s.id)).toEqual([b.id]);
    });
  });
});

describe('game files', () => {
  it('loads every bundled game', () => {
    const ids = loadGameFiles(fileURLToPath(gamesDir)).map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['fruits-88', 'fruits-96', 'fruits-demo']));
  });

  it('seeds only the games that are missing', () => {
    const store = createSqliteStore({ path: ':memory:' });
    expect(seedGames(store, [demo])).toEqual(['fruits-demo']);
    expect(seedGames(store, [demo])).toEqual([]);
    store.close();
  });
});
