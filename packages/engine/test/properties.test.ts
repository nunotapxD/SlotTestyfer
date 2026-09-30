/**
 * Property-based tests: instead of a few hand-picked cases, fast-check generates hundreds of
 * random games, screens and seeds and checks rules that must hold for every one of them.
 * When a rule breaks, fast-check shrinks the input to the smallest failing example.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  countSymbol,
  createRng,
  createRoundEngine,
  evaluate,
  parseGameConfig,
  screenFromStops,
  spin,
  type GameConfig,
} from '../src/index.js';

const SYMBOLS = ['A', 'B', 'C', 'W', 'S'] as const;

/** A random but valid game: 3 to 5 reels, 1 to 4 rows, random strips, paylines and prizes. */
const gameArb = fc
  .record({
    reels: fc.integer({ min: 3, max: 5 }),
    rows: fc.integer({ min: 1, max: 4 }),
    stripLength: fc.integer({ min: 4, max: 12 }),
    seed: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    lines: fc.integer({ min: 1, max: 6 }),
    pays: fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 5, maxLength: 5 }),
    freeSpins: fc.boolean(),
  })
  .map(({ reels, rows, stripLength, seed, lines, pays, freeSpins }): GameConfig => {
    const rng = createRng(seed);
    const pick = () => SYMBOLS[rng.nextInt(SYMBOLS.length)] ?? 'A';
    return parseGameConfig({
      id: 'prop',
      name: 'Property game',
      rows,
      symbols: [
        { id: 'A', kind: 'regular' },
        { id: 'B', kind: 'regular' },
        { id: 'C', kind: 'regular' },
        { id: 'W', kind: 'wild' },
        { id: 'S', kind: 'scatter' },
      ],
      reels: Array.from({ length: reels }, () => Array.from({ length: stripLength }, pick)),
      paylines: Array.from({ length: lines }, () =>
        Array.from({ length: reels }, () => rng.nextInt(rows)),
      ),
      paytable: [
        { symbol: 'A', count: 3, pays: pays[0] ?? 1 },
        { symbol: 'B', count: 3, pays: pays[1] ?? 1 },
        { symbol: 'C', count: reels, pays: pays[2] ?? 1 },
        { symbol: 'W', count: 3, pays: pays[3] ?? 1 },
        { symbol: 'S', count: 3, pays: pays[4] ?? 1 },
      ],
      ...(freeSpins ? { freeSpins: { symbol: 'S', count: 3, spins: 3, multiplier: 2 } } : {}),
    });
  });

const seedArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

describe('engine properties', () => {
  it('nextInt always stays inside [0, n)', () => {
    fc.assert(
      fc.property(seedArb, fc.integer({ min: 1, max: 1_000_000 }), (seed, n) => {
        const rng = createRng(seed);
        for (let i = 0; i < 20; i++) {
          const x = rng.nextInt(n);
          if (!(Number.isInteger(x) && x >= 0 && x < n)) return false;
        }
        return true;
      }),
    );
  });

  it('a spin shows the reel strips at its stops', () => {
    fc.assert(
      fc.property(gameArb, seedArb, (game, seed) => {
        const result = spin(game, createRng(seed));
        expect(result.screen).toEqual(screenFromStops(game, result.stops));
        expect(result.screen).toHaveLength(game.reels.length);
        result.screen.forEach((column) => expect(column).toHaveLength(game.rows));
      }),
      { numRuns: 200 },
    );
  });

  it('prizes are never negative, and add up to the total', () => {
    fc.assert(
      fc.property(gameArb, seedArb, (game, seed) => {
        const { screen } = spin(game, createRng(seed));
        const result = evaluate(game, screen);
        const lines = game.paylines.length;
        const sum =
          result.lineWins.reduce((s, w) => s + w.pays, 0) +
          result.scatterWins.reduce((s, w) => s + w.pays * lines, 0);
        return (
          result.winLineBets >= 0 &&
          Number.isInteger(result.winLineBets) &&
          result.winLineBets === sum &&
          result.multiplier === result.winLineBets / lines
        );
      }),
      { numRuns: 300 },
    );
  });

  it('a line win never pays more than the best prize in the paytable', () => {
    fc.assert(
      fc.property(gameArb, seedArb, (game, seed) => {
        const best = Math.max(...game.paytable.map((p) => p.pays));
        const { screen } = spin(game, createRng(seed));
        return evaluate(game, screen).lineWins.every(
          (w) => w.pays <= best && w.count <= game.reels.length && w.wilds <= w.count,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('the same seed always plays the same round', () => {
    fc.assert(
      fc.property(gameArb, seedArb, (game, seed) => {
        const a = createRoundEngine(game)(createRng(seed));
        const b = createRoundEngine(game)(createRng(seed));
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });

  it('free spins happen exactly when enough scatters land, and the total adds up', () => {
    fc.assert(
      fc.property(gameArb, seedArb, (game, seed) => {
        const outcome = createRoundEngine(game)(createRng(seed));
        const feature = game.freeSpins;
        const triggered = feature
          ? countSymbol(outcome.base.screen, feature.symbol) >= feature.count
          : false;
        expect(outcome.freeSpins !== null).toBe(triggered);
        expect(outcome.winLineBets).toBe(
          outcome.base.evaluation.winLineBets + (outcome.freeSpins?.winLineBets ?? 0),
        );
      }),
      { numRuns: 200 },
    );
  });
});
