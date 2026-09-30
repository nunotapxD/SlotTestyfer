/**
 * Builds the Fastify application. Kept separate from server.ts so tests can create an app with
 * an in-memory database and call it with app.inject(), without opening a port.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ENGINE_VERSION } from '@slottestyfer/engine';
import { ApiError } from './errors.js';
import { registerGameRoutes } from './routes/games.js';
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
  /** Fastify logger: false in tests, a level such as 'info' in the server. */
  readonly logger?: boolean | { level: string };
}

export interface App {
  readonly app: FastifyInstance;
  readonly runner: SimulationRunner;
}

export const DEFAULT_MAX_SPINS = 100_000_000;

export async function buildApp(options: AppOptions): Promise<App> {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: {
      // Reject unknown fields instead of silently dropping them; allow OpenAPI's `example`.
      customOptions: { removeAdditional: false, keywords: ['example'] },
    },
  });

  const runner = createRunner({
    store: options.store,
    workers: options.workers,
    logger: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
  });
  app.addHook('onReady', async () => runner.recover());
  app.addHook('onClose', async () => runner.stop());

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
        { name: 'health', description: 'Service status' },
      ],
    },
    // Name shared schemas after their $id in the OpenAPI document instead of def-0, def-1...
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

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

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: 'not_found', message: `no route for ${request.method} ${request.url}` }),
  );

  app.get('/health', { schema: healthRoute }, async () => ({
    status: 'ok' as const,
    games: options.store.listGames().length,
  }));

  registerGameRoutes(app, options.store);
  registerSpinRoutes(app, options.store);
  registerSimulationRoutes(app, {
    store: options.store,
    runner,
    maxSpins: options.maxSpins ?? DEFAULT_MAX_SPINS,
  });

  return { app, runner };
}
