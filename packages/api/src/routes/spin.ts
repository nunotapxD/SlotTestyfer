import { randomInt } from 'node:crypto';
import { createRng, playRound, type Evaluation } from '@slottestyfer/engine';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import { spinRoute } from '../schemas.js';
import type { Store } from '../store.js';

interface SpinBody {
  gameId: string;
  bet: number;
  seed?: number;
}

/** Wins of one spin with their value in cents (multiplier applied for free spins). */
function wins(evaluation: Evaluation, bet: number, lines: number, multiplier = 1) {
  const lineBet = bet / lines;
  return {
    lineWins: evaluation.lineWins.map((w) => ({ ...w, win: w.pays * lineBet * multiplier })),
    scatterWins: evaluation.scatterWins.map((w) => ({ ...w, win: w.pays * bet * multiplier })),
  };
}

export function registerSpinRoutes(app: FastifyInstance, store: Store): void {
  app.post<{ Body: SpinBody }>('/spin', { schema: spinRoute }, async (request) => {
    const { gameId, bet } = request.body;
    const game = await store.getGame(gameId);
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
    const feature = round.freeSpins;
    return {
      gameId,
      seed,
      bet,
      win: round.winCents,
      multiplier: round.winCents / bet,
      stops: round.stops,
      screen: round.screen,
      ...wins(round.evaluation, bet, lines),
      freeSpins: feature
        ? {
            multiplier: feature.multiplier,
            win: feature.winCents,
            spins: feature.spins.map((s) => ({
              stops: s.stops,
              screen: s.screen,
              win: s.winCents,
              ...wins(s.evaluation, bet, lines, feature.multiplier),
            })),
          }
        : null,
    };
  });
}
