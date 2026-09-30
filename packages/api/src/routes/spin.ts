import { randomInt } from 'node:crypto';
import { createRng, playRound } from '@slottestyfer/engine';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import { spinRoute } from '../schemas.js';
import type { Store } from '../store.js';

interface SpinBody {
  gameId: string;
  bet: number;
  seed?: number;
}

export function registerSpinRoutes(app: FastifyInstance, store: Store): void {
  app.post<{ Body: SpinBody }>('/spin', { schema: spinRoute }, async (request) => {
    const { gameId, bet } = request.body;
    const game = store.getGame(gameId);
    if (!game) throw notFound('game', gameId);

    // A fresh seed per round unless the caller wants to replay one.
    const seed = request.body.seed ?? randomInt(0, 2 ** 32);
    const lines = game.config.paylines.length;
    if (bet % lines !== 0) {
      throw new ApiError(
        400,
        'invalid_bet',
        `bet must be a multiple of ${lines} cents so it splits evenly across the paylines`,
      );
    }

    const round = playRound(game.config, createRng(seed), bet);
    const lineBet = bet / lines;
    return {
      gameId,
      seed,
      bet,
      win: round.winCents,
      multiplier: round.evaluation.multiplier,
      stops: round.stops,
      screen: round.screen,
      lineWins: round.evaluation.lineWins.map((w) => ({ ...w, win: w.pays * lineBet })),
      scatterWins: round.evaluation.scatterWins.map((w) => ({ ...w, win: w.pays * bet })),
    };
  });
}
