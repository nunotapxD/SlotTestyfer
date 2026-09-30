import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGameConfig } from '@slottestyfer/engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadGameFiles, seedGames } from '../src/games.js';
import type { SimulationRunner } from '../src/runner.js';
import { createSqliteStore, type Store } from '../src/store.js';

const gamesDir = fileURLToPath(new URL('../../../games/', import.meta.url));
const demo = parseGameConfig(
  JSON.parse(readFileSync(new URL('../../../games/fruits-demo.json', import.meta.url), 'utf8')),
);

let store: Store;
let app: FastifyInstance;
let runner: SimulationRunner;

beforeEach(async () => {
  store = createSqliteStore({ path: ':memory:' });
  seedGames(store, loadGameFiles(gamesDir));
  // workers: 0 runs simulations in the test thread, so no compiled worker script is needed.
  ({ app, runner } = await buildApp({ store, workers: 0, maxSpins: 1_000_000, chunkSize: 10_000 }));
  await app.ready();
});

afterEach(async () => {
  await runner.idle();
  await app.close();
  store.close();
});

describe('GET /health', () => {
  it('reports ok and the number of games', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', games: 3 });
  });
});

describe('games', () => {
  it('lists the bundled games with a summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/games' });
    expect(res.statusCode).toBe(200);
    const games = res.json<{ id: string }[]>();
    expect(games.map((g) => g.id)).toEqual(['fruits-88', 'fruits-96', 'fruits-demo']);
    expect(games[0]).toMatchObject({ reels: 3, rows: 3, paylines: 5 });
  });

  it('returns the full config of one game', async () => {
    const res = await app.inject({ method: 'GET', url: '/games/fruits-demo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(demo);
  });

  it('answers 404 with the standard error body for an unknown game', async () => {
    const res = await app.inject({ method: 'GET', url: '/games/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'game "nope" does not exist' });
  });

  it('registers a new game', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/games',
      payload: { ...demo, id: 'my-game', name: 'My game' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['location']).toBe('/games/my-game');
    expect(res.json()).toMatchObject({ id: 'my-game', name: 'My game', reels: 3 });
    expect((await app.inject({ method: 'GET', url: '/games/my-game' })).statusCode).toBe(200);
  });

  it('rejects an invalid game and lists every problem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/games',
      payload: { ...demo, id: 'broken', reels: [['CHERRY', 'NOPE']], paylines: [[7]] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; issues: string[] }>();
    expect(body.error).toBe('invalid_game');
    expect(body.issues).toEqual(
      expect.arrayContaining([
        'reels.0: reel 0 has 2 stops but the screen shows 3 rows',
        'reels.0.1: unknown symbol NOPE',
      ]),
    );
  });

  it('refuses a duplicate id with 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/games', payload: demo });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'game_exists' });
  });
});

describe('POST /spin', () => {
  it('plays a round and pays in whole cents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/spin',
      payload: { gameId: 'fruits-96', bet: 500, seed: 42 },
    });
    expect(res.statusCode).toBe(200);
    const round = res.json<{
      seed: number;
      bet: number;
      win: number;
      stops: number[];
      screen: string[][];
      lineWins: { win: number }[];
      scatterWins: { win: number }[];
    }>();
    expect(round.seed).toBe(42);
    expect(round.bet).toBe(500);
    expect(round.screen).toHaveLength(3);
    expect(round.stops).toHaveLength(3);
    const parts = [...round.lineWins, ...round.scatterWins].reduce((sum, w) => sum + w.win, 0);
    expect(round.win).toBe(parts);
    expect(Number.isInteger(round.win)).toBe(true);
  });

  it('replays exactly the same round from its seed', async () => {
    const spin = () =>
      app.inject({
        method: 'POST',
        url: '/spin',
        payload: { gameId: 'fruits-96', bet: 500, seed: 7 },
      });
    expect((await spin()).json()).toEqual((await spin()).json());
  });

  it('picks and returns a seed when none is given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/spin',
      payload: { gameId: 'fruits-96', bet: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(Number.isInteger(res.json<{ seed: number }>().seed)).toBe(true);
  });

  it('rejects a bet that does not split across the paylines', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/spin',
      payload: { gameId: 'fruits-96', bet: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_bet' });
  });

  it('validates the body against the schema', async () => {
    for (const payload of [
      { gameId: 'fruits-96' },
      { gameId: 'fruits-96', bet: 0 },
      { gameId: 'fruits-96', bet: 2.5 },
      { gameId: 'fruits-96', bet: 5, extra: true },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/spin', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('answers 404 for an unknown game', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/spin',
      payload: { gameId: 'nope', bet: 5 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('simulations', () => {
  type Simulation = {
    id: string;
    status: string;
    progress: number;
    seed: number;
    target: number | null;
    tolerance: number;
    report: { rtp: number; rounds: number } | null;
    verdict: { status: string } | null;
  };

  it('starts in the background with 202, then reports the result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/simulations',
      payload: { gameId: 'fruits-96', spins: 100_000, seed: 42, target: 0.96, tolerance: 0.05 },
    });
    expect(res.statusCode).toBe(202);
    const created = res.json<Simulation>();
    expect(res.headers['location']).toBe(`/simulations/${created.id}`);
    expect(created).toMatchObject({ status: 'queued', progress: 0, seed: 42, target: 0.96 });

    await runner.idle();

    const done = (
      await app.inject({ method: 'GET', url: `/simulations/${created.id}` })
    ).json<Simulation>();
    expect(done.status).toBe('done');
    expect(done.progress).toBe(1);
    expect(done.report?.rounds).toBe(100_000);
    expect(done.verdict?.status).toBe('PASS');
  });

  it('uses the default tolerance and no verdict without a target', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/simulations',
      payload: { gameId: 'fruits-96', spins: 1000 },
    });
    const created = res.json<Simulation>();
    expect(created.tolerance).toBe(0.005);
    expect(created.target).toBeNull();
    await runner.idle();
    const done = (
      await app.inject({ method: 'GET', url: `/simulations/${created.id}` })
    ).json<Simulation>();
    expect(done.verdict).toBeNull();
  });

  it('lists simulations, most recent first, filtered by game', async () => {
    const start = (gameId: string) =>
      app.inject({ method: 'POST', url: '/simulations', payload: { gameId, spins: 1000 } });
    const a = (await start('fruits-96')).json<Simulation>();
    const b = (await start('fruits-88')).json<Simulation>();
    await runner.idle();

    const all = (await app.inject({ method: 'GET', url: '/simulations' })).json<Simulation[]>();
    expect(all.map((s) => s.id)).toEqual([b.id, a.id]);
    const only96 = (await app.inject({ method: 'GET', url: '/simulations?gameId=fruits-96' })).json<
      Simulation[]
    >();
    expect(only96.map((s) => s.id)).toEqual([a.id]);
  });

  it('rejects simulations above the spin limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/simulations',
      payload: { gameId: 'fruits-96', spins: 2_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'too_many_spins' });
  });

  it('answers 404 for an unknown game or simulation', async () => {
    const unknownGame = await app.inject({
      method: 'POST',
      url: '/simulations',
      payload: { gameId: 'nope', spins: 10 },
    });
    expect(unknownGame.statusCode).toBe(404);
    const unknownSim = await app.inject({ method: 'GET', url: '/simulations/nope' });
    expect(unknownSim.statusCode).toBe(404);
  });
});

describe('docs and errors', () => {
  it('serves the OpenAPI document with every route', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/games',
        '/games/{id}',
        '/spin',
        '/simulations',
        '/simulations/{id}',
      ]),
    );
  });

  it('answers unknown routes with the standard 404 body', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});
