/**
 * JSON schemas for requests and responses. Fastify uses them to validate input, to serialize
 * output quickly, and @fastify/swagger turns them into the OpenAPI document at /docs.
 */

export const errorSchema = {
  $id: 'Error',
  type: 'object',
  description: 'Every error has this shape.',
  properties: {
    error: { type: 'string', description: 'Short machine-readable code, e.g. not_found' },
    message: { type: 'string' },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every problem found, for invalid game configurations',
    },
  },
  required: ['error', 'message'],
} as const;

const errorRef = { $ref: 'Error#' } as const;

export const gameSummarySchema = {
  $id: 'GameSummary',
  type: 'object',
  properties: {
    id: { type: 'string', example: 'fruits-96' },
    name: { type: 'string', example: 'Fruits 96' },
    reels: { type: 'integer', example: 3 },
    rows: { type: 'integer', example: 3 },
    paylines: { type: 'integer', example: 5 },
    freeSpins: { type: 'boolean', description: 'Has a free spins feature' },
    rtp: { type: 'number', description: 'Exact RTP by formula, as a fraction' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'name', 'reels', 'rows', 'paylines', 'freeSpins', 'rtp', 'createdAt'],
} as const;

const positionsSchema = {
  type: 'array',
  items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
  description: '[reel, row] of each symbol in the win',
} as const;

const lineWinsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      payline: { type: 'integer' },
      symbol: { type: 'string' },
      count: { type: 'integer' },
      pays: { type: 'integer' },
      wilds: { type: 'integer' },
      win: { type: 'integer', description: 'Cents, multiplier applied' },
      positions: positionsSchema,
    },
  },
} as const;

const scatterWinsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      count: { type: 'integer' },
      pays: { type: 'integer' },
      win: { type: 'integer', description: 'Cents, multiplier applied' },
      positions: positionsSchema,
    },
  },
} as const;

const screenSchema = {
  type: 'array',
  items: { type: 'array', items: { type: 'string' } },
  description: 'screen[reel][row], row 0 at the top',
} as const;

export const simulationSchema = {
  $id: 'Simulation',
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    gameId: { type: 'string' },
    spins: { type: 'integer' },
    seed: { type: 'integer' },
    target: { type: ['number', 'null'], description: 'Target RTP as a fraction, e.g. 0.96' },
    tolerance: { type: 'number', description: 'Allowed deviation as a fraction, e.g. 0.005' },
    status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] },
    roundsDone: { type: 'integer' },
    progress: { type: 'number', description: 'From 0 to 1' },
    createdAt: { type: 'string', format: 'date-time' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
    report: {
      type: ['object', 'null'],
      additionalProperties: true,
      description: 'RTP, hit frequency, volatility, confidence interval, histogram, breakdowns',
    },
    verdict: {
      type: ['object', 'null'],
      additionalProperties: true,
      description: 'PASS, FAIL or INCONCLUSIVE against target ± tolerance',
    },
    error: { type: ['string', 'null'] },
  },
  required: ['id', 'gameId', 'spins', 'seed', 'status', 'roundsDone', 'progress', 'createdAt'],
} as const;

export const liveStateSchema = {
  $id: 'LiveRun',
  type: 'object',
  additionalProperties: true,
  description: 'A live run: settings, status and the latest batch of numbers.',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['running', 'paused', 'finished', 'cancelled', 'failed'] },
  },
  required: ['id', 'status'],
} as const;

export const sharedSchemas = [errorSchema, gameSummarySchema, simulationSchema, liveStateSchema];

const idParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const;

export const healthRoute = {
  tags: ['health'],
  summary: 'Liveness check used by Docker',
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        games: { type: 'integer' },
        database: { type: 'string', enum: ['sqlite', 'postgres'] },
      },
      required: ['status', 'games', 'database'],
    },
  },
} as const;

export const listGamesRoute = {
  tags: ['games'],
  summary: 'List the available games',
  response: { 200: { type: 'array', items: { $ref: 'GameSummary#' } } },
} as const;

export const getGameRoute = {
  tags: ['games'],
  summary: 'Get the full configuration of a game',
  params: idParams,
  response: {
    200: { type: 'object', additionalProperties: true, description: 'The game configuration' },
    404: errorRef,
  },
} as const;

export const createGameRoute = {
  tags: ['games'],
  summary: 'Register a new game',
  description:
    'The body is a game configuration (see games/*.json). It is checked in full: symbols, ' +
    'reel strips, paylines, paytable and free spins must be consistent. Every problem is listed ' +
    'in `issues`.',
  body: { type: 'object', additionalProperties: true },
  response: { 201: { $ref: 'GameSummary#' }, 400: errorRef, 409: errorRef },
} as const;

export const spinRoute = {
  tags: ['rounds'],
  summary: 'Play one round with fictional credits',
  description:
    'Returns the screen, every win and the payout, including any free spins the round ' +
    'triggered. Pass the returned seed to replay the round exactly. Amounts are in cents of ' +
    'fictional credits; the bet must split evenly across the paylines.',
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      gameId: { type: 'string', example: 'fruits-96' },
      bet: { type: 'integer', minimum: 1, maximum: 100_000_000, example: 500 },
      seed: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    },
    required: ['gameId', 'bet'],
  },
  response: {
    200: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seed: { type: 'integer' },
        bet: { type: 'integer' },
        win: { type: 'integer', description: 'Everything the round paid, free spins included' },
        multiplier: { type: 'number' },
        stops: { type: 'array', items: { type: 'integer' } },
        screen: screenSchema,
        lineWins: lineWinsSchema,
        scatterWins: scatterWinsSchema,
        freeSpins: {
          type: ['object', 'null'],
          description: 'Free spins triggered by this round, or null',
          properties: {
            multiplier: { type: 'integer' },
            win: { type: 'integer' },
            spins: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stops: { type: 'array', items: { type: 'integer' } },
                  screen: screenSchema,
                  win: { type: 'integer' },
                  lineWins: lineWinsSchema,
                  scatterWins: scatterWinsSchema,
                },
              },
            },
          },
        },
      },
    },
    400: errorRef,
    404: errorRef,
  },
} as const;

export const createSimulationRoute = {
  tags: ['simulations'],
  summary: 'Start a Monte Carlo simulation in the background',
  description:
    'Returns 202 straight away with the simulation id. Poll GET /simulations/{id} until the ' +
    'status is done or failed. Simulations run one at a time, in order.',
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      gameId: { type: 'string', example: 'fruits-96' },
      spins: { type: 'integer', minimum: 1, example: 10_000_000 },
      seed: { type: 'integer', minimum: 0, maximum: 4_294_967_295, example: 42 },
      target: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 10,
        example: 0.96,
        description: 'Target RTP as a fraction. Omit for no verdict.',
      },
      tolerance: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 1,
        default: 0.005,
        example: 0.005,
        description: 'Allowed deviation as a fraction (0.005 = 0.5 percentage points)',
      },
    },
    required: ['gameId', 'spins'],
  },
  response: { 202: { $ref: 'Simulation#' }, 400: errorRef, 404: errorRef },
} as const;

export const getSimulationRoute = {
  tags: ['simulations'],
  summary: 'Status, progress and results of a simulation',
  params: idParams,
  response: { 200: { $ref: 'Simulation#' }, 404: errorRef },
} as const;

export const simulationCsvRoute = {
  tags: ['simulations'],
  summary: 'Report of a finished simulation as CSV',
  description: 'Columns: section, name, value. Fractions stay fractions (0.9594).',
  params: idParams,
  produces: ['text/csv'],
  response: { 404: errorRef, 409: errorRef },
} as const;

export const listSimulationsRoute = {
  tags: ['simulations'],
  summary: 'Most recent simulations',
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      gameId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
  response: { 200: { type: 'array', items: { $ref: 'Simulation#' } } },
} as const;

export const createLiveRoute = {
  tags: ['live'],
  summary: 'Start a live run: the game plays continuously and streams its numbers',
  description:
    'Follow it with GET /live/{id}/events (Server-Sent Events). Batches arrive every 100 ms ' +
    'with the running RTP, its 95% confidence interval, the live verdict, virtual players and ' +
    'alerts. At most 4 runs can be active at once.',
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      gameId: { type: 'string', example: 'fruits-96' },
      seed: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
      target: { type: 'number', exclusiveMinimum: 0, maximum: 10, default: 0.96 },
      tolerance: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.005 },
      players: { type: 'integer', minimum: 0, maximum: 20, default: 8 },
      roundsPerSecond: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000_000,
        default: 20_000,
        description: '0 = as fast as possible',
      },
      maxRounds: { type: 'integer', minimum: 1, maximum: 1_000_000_000, default: 50_000_000 },
    },
    required: ['gameId'],
  },
  response: { 201: { $ref: 'LiveRun#' }, 400: errorRef, 404: errorRef, 429: errorRef },
} as const;

export const liveIdRoute = {
  tags: ['live'],
  params: idParams,
  response: { 200: { $ref: 'LiveRun#' }, 404: errorRef },
} as const;

export const liveSpeedRoute = {
  tags: ['live'],
  summary: 'Change the speed of a live run',
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { roundsPerSecond: { type: 'integer', minimum: 0, maximum: 10_000_000 } },
    required: ['roundsPerSecond'],
  },
  response: { 200: { $ref: 'LiveRun#' }, 404: errorRef },
} as const;

export const liveEventsRoute = {
  tags: ['live'],
  summary: 'Server-Sent Events stream of a live run',
  description:
    'First a `snapshot` event (state, history, alerts), then `batch` and `status` events. Every ' +
    'event has an increasing id. The stream ends when the run finishes or is cancelled.',
  params: idParams,
  produces: ['text/event-stream'],
} as const;

export const listLiveRoute = {
  tags: ['live'],
  summary: 'Live runs (active, and finished in the last 10 minutes)',
  response: { 200: { type: 'array', items: { $ref: 'LiveRun#' } } },
} as const;
