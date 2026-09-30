/**
 * Builds the Fastify application. Kept separate from server.ts so tests can create an app with
 * an in-memory database and call it with app.inject(), without opening a port.
 *
 * Two layouts:
 * - API only (docker compose, development): routes at /games, /spin, ...; nginx or Vite put the
 *   web page in front and forward /api/... here without the prefix.
 * - All in one (public deploy): `staticDir` serves the built web page at /, and the API moves
 *   under `apiPrefix` (/api), so the same page works unchanged.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ENGINE_VERSION } from '@slottestyfer/engine';
import { ApiError } from './errors.js';
import { LiveManager } from './live/manager.js';
import { registerGameRoutes } from './routes/games.js';
import { registerLiveRoutes } from './routes/live.js';
import { registerSimulationRoutes } from './routes/simulations.js';
import { registerSpinRoutes } from './routes/spin.js';
import { createRunner, type SimulationRunner } from './runner.js';
import { healthRoute, sharedSchemas } from './schemas.js';
import type { Store } from './store.js';

export interface AppOptions {
  readonly store: Store;
  /** Worker threads per simulation. 0 runs simulations in the main thread (tests only). */
  readonly workers: number;
  /** Largest simulation a request may ask for. */
  readonly maxSpins?: number;
  readonly chunkSize?: number;
  /** Run live simulations in the main thread instead of worker threads (tests only). */
  readonly inlineLive?: boolean;
  /** Most live runs active at once. Default 4. */
  readonly maxLiveRuns?: number;
  /** Put every API route under this prefix, e.g. '/api'. Default: none. */
  readonly apiPrefix?: string;
  /** Serve the built web page from this folder at /. */
  readonly staticDir?: string;
  /** Fastify logger: false in tests, a level such as 'info' in the server. */
  readonly logger?: boolean | { level: string };
}

export interface App {
  readonly app: FastifyInstance;
  readonly runner: SimulationRunner;
  readonly live: LiveManager;
}

export const DEFAULT_MAX_SPINS = 100_000_000;

export async function buildApp(options: AppOptions): Promise<App> {
  const prefix = options.apiPrefix ?? '';
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: {
      // Reject unknown fields instead of silently dropping them; allow OpenAPI's `example`.
      customOptions: { removeAdditional: false, keywords: ['example'] },
    },
  });

  const { store } = options;
  const runner = createRunner({
    store,
    workers: options.workers,
    logger: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
  });
  const live = new LiveManager({
    inline: options.inlineLive ?? false,
    ...(options.maxLiveRuns === undefined ? {} : { maxActive: options.maxLiveRuns }),
  });
  app.addHook('onReady', async () => runner.recover());
  app.addHook('onClose', async () => {
    runner.stop();
    await live.close();
  });

  for (const schema of sharedSchemas) app.addSchema(schema);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'SlotTestyfer API',
        version: ENGINE_VERSION,
        description:
          'Slot game engine and RTP tester. Fictional credits only: no real money, no accounts.',
      },
      tags: [
        { name: 'games', description: 'Game configurations' },
        { name: 'rounds', description: 'Single rounds with fictional credits' },
        { name: 'simulations', description: 'Monte Carlo simulations and certification' },
        { name: 'live', description: 'Live runs streamed with Server-Sent Events' },
        { name: 'health', description: 'Service status' },
      ],
    },
    // Name shared schemas after their $id in the OpenAPI document instead of def-0, def-1...
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
  });
  await app.register(swaggerUi, { routePrefix: `${prefix}/docs` });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(error.toJSON());
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error', message: 'unexpected error' });
    }
    return reply.code(status).send({ error: error.code ?? 'error', message: error.message });
  });

  const health = async () => ({
    status: 'ok' as const,
    games: (await store.listGames()).length,
    database: store.kind,
  });
  // Always at the root, for container healthchecks, whatever the prefix.
  app.get('/health', { schema: healthRoute }, health);

  await app.register(
    async (api) => {
      if (prefix) api.get('/health', { schema: healthRoute }, health);
      registerGameRoutes(api, store);
      registerSpinRoutes(api, store);
      registerSimulationRoutes(api, {
        store,
        runner,
        maxSpins: options.maxSpins ?? DEFAULT_MAX_SPINS,
      });
      registerLiveRoutes(api, { store, live });
    },
    { prefix },
  );

  const notFoundBody = (method: string, url: string) => ({
    error: 'not_found',
    message: `no route for ${method} ${url}`,
  });

  if (options.staticDir) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: options.staticDir, prefix: '/' });
    // Single-page app: any other GET outside the API gets index.html.
    app.setNotFoundHandler((request, reply) => {
      const isApi =
        prefix !== '' && (request.url === prefix || request.url.startsWith(`${prefix}/`));
      if (request.method === 'GET' && !isApi) return reply.sendFile('index.html');
      return reply.code(404).send(notFoundBody(request.method, request.url));
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.code(404).send(notFoundBody(request.method, request.url)),
    );
  }

  return { app, runner, live };
}
