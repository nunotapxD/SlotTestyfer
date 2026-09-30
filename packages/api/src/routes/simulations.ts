import { randomInt } from 'node:crypto';
import { reportToCsv } from '@slottestyfer/simulator/core';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import type { SimulationRunner } from '../runner.js';
import {
  createSimulationRoute,
  getSimulationRoute,
  listSimulationsRoute,
  simulationCsvRoute,
} from '../schemas.js';
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
      if (!(await store.getGame(gameId))) throw notFound('game', gameId);
      if (spins > maxSpins) {
        throw new ApiError(400, 'too_many_spins', `spins must be at most ${maxSpins}`);
      }

      const simulation = await store.createSimulation({
        gameId,
        spins,
        seed: request.body.seed ?? randomInt(0, 2 ** 32),
        target: request.body.target ?? null,
        tolerance,
      });
      runner.enqueue(simulation.id);

      return reply
        .code(202)
        .header('location', `${app.prefix}/simulations/${simulation.id}`)
        .send(simulationView(simulation));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/simulations/:id',
    { schema: getSimulationRoute },
    async (request) => {
      const simulation = await store.getSimulation(request.params.id);
      if (!simulation) throw notFound('simulation', request.params.id);
      return simulationView(simulation);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/simulations/:id/report.csv',
    { schema: simulationCsvRoute },
    async (request, reply) => {
      const simulation = await store.getSimulation(request.params.id);
      if (!simulation) throw notFound('simulation', request.params.id);
      if (!simulation.report) {
        throw new ApiError(409, 'not_finished', `simulation is ${simulation.status}, not done`);
      }
      const csv = reportToCsv(simulation.report, simulation.verdict, {
        game: simulation.gameId,
        spins: simulation.spins,
        seed: simulation.seed,
      });
      return reply
        .type('text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${simulation.gameId}-${simulation.id.slice(0, 8)}.csv"`,
        )
        .send(csv);
    },
  );

  app.get<{ Querystring: { gameId?: string; limit: number } }>(
    '/simulations',
    { schema: listSimulationsRoute },
    async (request) => {
      const { gameId, limit } = request.query;
      const list = await store.listSimulations(
        gameId === undefined ? { limit } : { gameId, limit },
      );
      return list.map(simulationView);
    },
  );
}
