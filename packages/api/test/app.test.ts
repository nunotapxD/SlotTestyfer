import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameConfig } from '@slottestyfer/engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadGameFiles, seedGames } from '../src/games.js';
import { createSqliteStore } from '../src/sqlite-store.js';
import type { Store } from '../src/store.js';

const gamesDir = fileURLToPath(new URL('../../../games/', import.meta.url));
const demo = parseGameConfig(
  JSON.parse(readFileSync(new URL('../../../games/fruits-demo.json', import.meta.url), 'utf8')),
);

let store: Store;
let built: App;
let app: FastifyInstance;

async function setup(extra: { apiPrefix?: string; staticDir?: string } = {}) {
  store = createSqliteStore({ path: ':memory:' });
  await seedGames(store, loadGameFiles(gamesDir));
  // workers: 0 and inlineLive run everything in the test thread (no compiled worker needed).
  built = await buildApp({
    store,
    workers: 0,
    inlineLive: true,
    maxSpins: 1_000_000,
    chunkSize: 10_000,
    ...extra,
  });
  app = built.app;
  await app.ready();
}

async function teardown() {
  await built.runner.idle();
  await app.close();
  await store.close();
}

/** Splits a Server-Sent Events body into { event, id, data } records. */
function parseSse(body: string) {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.includes('data:'))
    .map((chunk) => {
      const field = (name: string) =>
        chunk
          .split('\n')
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      const id = field('id');
      return {
        event: field('event') ?? 'message',
        id: id === undefined ? undefined : Number(id),
        data: JSON.parse(field('data') ?? 'null') as Record<string, unknown>,
      };
    });
}

describe('API', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  describe('GET /health', () => {
    it('reports ok, the number of games and the database', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', games: 4, database: 'sqlite' });
    });
  });

  describe('games', () => {
    it('lists the bundled games with a summary and their exact RTP', async () => {
      const res = await app.inject({ method: 'GET', url: '/games' });
      expect(res.statusCode).toBe(200);
      const games = res.json<{ id: string; rtp: number; freeSpins: boolean }[]>();
      expect(games.map((g) => g.id)).toEqual([
        'fruits-5x3',
        'fruits-88',
        'fruits-96',
        'fruits-demo',
      ]);
      expect(games.find((g) => g.id === 'fruits-96')?.rtp).toBeCloseTo(0.959375, 10);
      expect(games.find((g) => g.id === 'fruits-5x3')).toMatchObject({
        reels: 5,
        paylines: 20,
        freeSpins: true,
      });
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
    type Win = { win: number; wilds?: number };
    type Round = {
      seed: number;
      bet: number;
      win: number;
      stops: number[];
      screen: string[][];
      lineWins: Win[];
      scatterWins: Win[];
      freeSpins: { multiplier: number; win: number; spins: { win: number }[] } | null;
    };

    it('plays a round and pays in whole cents', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/spin',
        payload: { gameId: 'fruits-96', bet: 500, seed: 42 },
      });
      expect(res.statusCode).toBe(200);
      const round = res.json<Round>();
      expect(round.seed).toBe(42);
      expect(round.bet).toBe(500);
      expect(round.screen).toHaveLength(3);
      expect(round.stops).toHaveLength(3);
      expect(round.freeSpins).toBeNull();
      const parts = [...round.lineWins, ...round.scatterWins].reduce((sum, w) => sum + w.win, 0);
      expect(round.win).toBe(parts);
      expect(Number.isInteger(round.win)).toBe(true);
    });

    it('includes free spins, and the total adds up', async () => {
      // Find a seed that triggers the feature on fruits-5x3 (about 1 round in 140).
      let round: Round | undefined;
      for (let seed = 0; seed < 2000 && !round?.freeSpins; seed++) {
        const res = await app.inject({
          method: 'POST',
          url: '/spin',
          payload: { gameId: 'fruits-5x3', bet: 100, seed },
        });
        round = res.json<Round>();
      }
      const feature = round?.freeSpins;
      expect(feature).toBeTruthy();
      expect(feature?.multiplier).toBe(3);
      expect(feature?.spins).toHaveLength(15);
      expect(feature?.win).toBe(feature?.spins.reduce((sum, s) => sum + s.win, 0));
      const base = [...(round?.lineWins ?? []), ...(round?.scatterWins ?? [])].reduce(
        (sum, w) => sum + w.win,
        0,
      );
      expect(round?.win).toBe(base + (feature?.win ?? 0));
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

      await built.runner.idle();

      const done = (
        await app.inject({ method: 'GET', url: `/simulations/${created.id}` })
      ).json<Simulation>();
      expect(done.status).toBe('done');
      expect(done.progress).toBe(1);
      expect(done.report?.rounds).toBe(100_000);
      expect(done.verdict?.status).toBe('PASS');
    });

    it('exports a finished report as CSV, and refuses before it finishes', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/simulations',
          payload: { gameId: 'fruits-96', spins: 20_000, seed: 1, target: 0.96 },
        })
      ).json<Simulation>();
      const early = await app.inject({
        method: 'GET',
        url: `/simulations/${created.id}/report.csv`,
      });
      expect(early.statusCode).toBe(409);

      await built.runner.idle();
      const res = await app.inject({ method: 'GET', url: `/simulations/${created.id}/report.csv` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.body.trim().split('\n');
      expect(lines[0]).toBe('section,name,value');
      expect(lines).toContain('run,game,fruits-96');
      expect(lines.some((l) => l.startsWith('summary,rtp,'))).toBe(true);
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
      await built.runner.idle();
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
      await built.runner.idle();

      const all = (await app.inject({ method: 'GET', url: '/simulations' })).json<Simulation[]>();
      expect(all.map((s) => s.id)).toEqual([b.id, a.id]);
      const only96 = (
        await app.inject({ method: 'GET', url: '/simulations?gameId=fruits-96' })
      ).json<Simulation[]>();
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

  describe('live runs', () => {
    type LiveRun = { id: string; status: string };

    it('streams a snapshot, numbered batches and the final status over SSE', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/live',
        payload: { gameId: 'fruits-96', seed: 3, roundsPerSecond: 100_000, maxRounds: 50_000 },
      });
      expect(created.statusCode).toBe(201);
      const run = created.json<LiveRun>();

      const res = await app.inject({ method: 'GET', url: `/live/${run.id}/events` });
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSse(res.body);
      expect(events[0]?.event).toBe('snapshot');

      const numbered = events.filter((e) => e.id !== undefined);
      const ids = numbered.map((e) => e.id ?? 0);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);

      const last = events[events.length - 1];
      expect(last).toMatchObject({ event: 'status', data: { status: 'finished' } });
      const batches = events.filter((e) => e.event === 'batch');
      expect(batches[batches.length - 1]?.data['rounds']).toBe(50_000);
    });

    it('pauses, resumes and cancels', async () => {
      const run = (
        await app.inject({
          method: 'POST',
          url: '/live',
          payload: { gameId: 'fruits-88', roundsPerSecond: 1000, maxRounds: 1_000_000_000 },
        })
      ).json<LiveRun>();

      const pause = await app.inject({ method: 'POST', url: `/live/${run.id}/pause` });
      expect(pause.statusCode).toBe(200);
      const speed = await app.inject({
        method: 'PUT',
        url: `/live/${run.id}/speed`,
        payload: { roundsPerSecond: 5000 },
      });
      expect(speed.json()).toMatchObject({ settings: { roundsPerSecond: 5000 } });
      await app.inject({ method: 'POST', url: `/live/${run.id}/resume` });
      await app.inject({ method: 'POST', url: `/live/${run.id}/cancel` });

      // The stream ends once the run reports that it was cancelled (if it already has, the
      // snapshot alone says so).
      const res = await app.inject({ method: 'GET', url: `/live/${run.id}/events` });
      const statuses = parseSse(res.body)
        .map((e) => e.data['status'])
        .filter((status) => status !== undefined);
      expect(statuses[statuses.length - 1]).toBe('cancelled');
      expect((await app.inject({ method: 'GET', url: `/live/${run.id}` })).json()).toMatchObject({
        status: 'cancelled',
      });
    });

    it('answers 404 for an unknown run and validates the body', async () => {
      expect((await app.inject({ method: 'GET', url: '/live/nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/live/nope/pause' })).statusCode).toBe(404);
      const bad = await app.inject({
        method: 'POST',
        url: '/live',
        payload: { gameId: 'fruits-96', players: 500 },
      });
      expect(bad.statusCode).toBe(400);
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
          '/simulations/{id}/report.csv',
          '/live',
          '/live/{id}/events',
        ]),
      );
    });

    it('answers unknown routes with the standard 404 body', async () => {
      const res = await app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    });
  });
});

describe('all-in-one mode (web page + API under /api)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slottestyfer-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SlotTestyfer</title>');
    await setup({ apiPrefix: '/api', staticDir: dir });
  });

  afterEach(async () => {
    await teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page at / and the API under /api', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>SlotTestyfer</title>');
    const games = await app.inject({ method: 'GET', url: '/api/games' });
    expect(games.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('falls back to the page for other paths, but not for the API', async () => {
    const deep = await app.inject({ method: 'GET', url: '/some/page' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('SlotTestyfer');
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });
  });
});
