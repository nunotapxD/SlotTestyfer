import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import type { SimulationRunner } from '../runner.js';
import { createSimulationRoute, getSimulationRoute, listSimulationsRoute } from '../schemas.js';
import type { SimulationRecord, Store } from '../store.js';

interface CreateSimulationBody {
  gameId: string;
  spins: number;
  seed?: number;
  target?: number;
  tolerance: number;
}

export function simulationView(simulation: SimulationRecord) {
  return { ...simulation, progress: simulation.roundsDone / simulation.spins };
}

export interface SimulationRouteDeps {
  readonly store: Store;
  readonly runner: SimulationRunner;
  readonly maxSpins: number;
}

export function registerSimulationRoutes(app: FastifyInstance, deps: SimulationRouteDeps): void {
  const { store, runner, maxSpins } = deps;

  app.post<{ Body: CreateSimulationBody }>(
    '/simulations',
    { schema: createSimulationRoute },
    async (request, reply) => {
      const { gameId, spins, tolerance } = request.body;
      if (!store.getGame(gameId)) throw notFound('game', gameId);
      if (spins > maxSpins) {
        throw new ApiError(400, 'too_many_spins', `spins must be at most ${maxSpins}`);
      }

      const simulation = store.createSimulation({
        gameId,
        spins,
        seed: request.body.seed ?? randomInt(0, 2 ** 32),
        target: request.body.target ?? null,
        tolerance,
      });
      runner.enqueue(simulation.id);

      return reply
        .code(202)
        .header('location', `/simulations/${simulation.id}`)
        .send(simulationView(simulation));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/simulations/:id',
    { schema: getSimulationRoute },
    async (request) => {
      const simulation = store.getSimulation(request.params.id);
      if (!simulation) throw notFound('simulation', request.params.id);
      return simulationView(simulation);
    },
  );

  app.get<{ Querystring: { gameId?: string; limit: number } }>(
    '/simulations',
    { schema: listSimulationsRoute },
    async (request) => {
      const { gameId, limit } = request.query;
      return store
        .listSimulations(gameId === undefined ? { limit } : { gameId, limit })
        .map(simulationView);
    },
  );
}
