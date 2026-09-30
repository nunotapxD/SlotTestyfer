import { GameConfigError, parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { computeRtp } from '@slottestyfer/simulator/core';
import type { FastifyInstance } from 'fastify';
import { ApiError, notFound } from '../errors.js';
import { createGameRoute, getGameRoute, listGamesRoute } from '../schemas.js';
import { GameExistsError, type Store, type StoredGame } from '../store.js';

/** The exact RTP takes a few milliseconds for big games, so it is computed once per game. */
const rtpCache = new Map<string, number>();

export function gameSummary(game: StoredGame) {
  const key = `${game.id}@${game.createdAt}`;
  let rtp = rtpCache.get(key);
  if (rtp === undefined) {
    rtp = computeRtp(game.config).rtp;
    rtpCache.set(key, rtp);
  }
  return {
    id: game.id,
    name: game.name,
    reels: game.config.reels.length,
    rows: game.config.rows,
    paylines: game.config.paylines.length,
    freeSpins: game.config.freeSpins !== undefined,
    rtp,
    createdAt: game.createdAt,
  };
}

/** Validates a request body as a game, turning config errors into a 400 with every issue. */
function validateGame(body: unknown): GameConfig {
  try {
    return parseGameConfig(body);
  } catch (error) {
    if (error instanceof GameConfigError) {
      throw new ApiError(400, 'invalid_game', 'the game configuration is invalid', error.issues);
    }
    throw error;
  }
}

export function registerGameRoutes(app: FastifyInstance, store: Store): void {
  app.get('/games', { schema: listGamesRoute }, async () =>
    (await store.listGames()).map(gameSummary),
  );

  app.get<{ Params: { id: string } }>('/games/:id', { schema: getGameRoute }, async (request) => {
    const game = await store.getGame(request.params.id);
    if (!game) throw notFound('game', request.params.id);
    return game.config;
  });

  app.post<{ Body: unknown }>('/games', { schema: createGameRoute }, async (request, reply) => {
    const config = validateGame(request.body);
    try {
      const game = await store.addGame(config);
      return reply
        .code(201)
        .header('location', `${app.prefix}/games/${game.id}`)
        .send(gameSummary(game));
    } catch (error) {
      if (error instanceof GameExistsError) throw new ApiError(409, 'game_exists', error.message);
      throw error;
    }
  });
}
