/**
 * Live runs over Server-Sent Events: start, watch, pause, resume, cancel, change speed.
 *
 * SSE rather than WebSocket because the data only flows one way (server to browser), it works
 * through ordinary HTTP proxies, and the browser's EventSource reconnects by itself. Commands are
 * plain POST/PUT requests.
 */
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import { TooManyLiveRunsError, type LiveManager, type LiveMessage } from '../live/manager.js';
import {
  createLiveRoute,
  listLiveRoute,
  liveEventsRoute,
  liveIdRoute,
  liveSpeedRoute,
} from '../schemas.js';
import type { Store } from '../store.js';

interface CreateLiveBody {
  gameId: string;
  seed?: number;
  target: number;
  tolerance: number;
  players: number;
  roundsPerSecond: number;
  maxRounds: number;
}

const HEARTBEAT_MS = 15_000;

export function registerLiveRoutes(
  app: FastifyInstance,
  deps: { readonly store: Store; readonly live: LiveManager },
): void {
  const { store, live } = deps;
  const find = (id: string) => {
    const run = live.get(id);
    if (!run) throw notFound('live run', id);
    return run;
  };

  app.post<{ Body: CreateLiveBody }>(
    '/live',
    { schema: createLiveRoute },
    async (request, reply) => {
      const body = request.body;
      const game = await store.getGame(body.gameId);
      if (!game) throw notFound('game', body.gameId);
      try {
        const run = live.start(game.config, {
          seed: body.seed ?? randomInt(0, 2 ** 32),
          target: body.target,
          tolerance: body.tolerance,
          players: body.players,
          playerRoundsPerTick: 2,
          startBalance: 100,
          roundsPerSecond: body.roundsPerSecond,
          maxRounds: body.maxRounds,
        });
        return reply.code(201).header('location', `${app.prefix}/live/${run.id}`).send(run.view());
      } catch (error) {
        if (error instanceof TooManyLiveRunsError) {
          throw new ApiError(429, 'too_many_live_runs', error.message);
        }
        throw error;
      }
    },
  );

  app.get('/live', { schema: listLiveRoute }, async () => live.list());

  app.get<{ Params: { id: string } }>('/live/:id', { schema: liveIdRoute }, async (request) =>
    find(request.params.id).view(),
  );

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post<{ Params: { id: string } }>(
      `/live/:id/${action}`,
      {
        schema: {
          ...liveIdRoute,
          summary: `${action[0]?.toUpperCase()}${action.slice(1)} a live run`,
        },
      },
      async (request) => {
        const run = find(request.params.id);
        run.command({ type: action });
        return run.view();
      },
    );
  }

  app.put<{ Params: { id: string }; Body: { roundsPerSecond: number } }>(
    '/live/:id/speed',
    { schema: liveSpeedRoute },
    async (request) => {
      const run = find(request.params.id);
      run.command({ type: 'speed', roundsPerSecond: request.body.roundsPerSecond });
      return run.view();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/live/:id/events',
    { schema: liveEventsRoute },
    async (request, reply) => {
      const run = find(request.params.id);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells nginx not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      const write = (event: string, data: unknown, id?: number) => {
        res.write(
          `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };

      write('snapshot', run.snapshot());
      if (run.done) {
        res.end();
        return;
      }

      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      heartbeat.unref();
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      unsubscribe = run.subscribe((message: LiveMessage) => {
        write(message.type, message.data, message.seq);
        if (message.type === 'status' && run.done) {
          close();
          res.end();
        }
      });
      request.raw.on('close', close);
    },
  );
}
