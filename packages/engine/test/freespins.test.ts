import { describe, expect, it } from 'vitest';
import {
  countSymbol,
  createRng,
  createRoundEngine,
  parseGameConfig,
  playRound,
  type GameConfig,
} from '../src/index.js';

/**
 * 3 reels x 1 row, 1 payline. Every stop is a scatter, so every round triggers the feature:
 * base = 3 scatters = 5x the bet, each free spin = 5x the bet x 2, three free spins.
 * Total = 5 + 3 x 5 x 2 = 35 line bets (1 line, so 35x the total bet).
 */
const alwaysTriggers = parseGameConfig({
  id: 'always',
  name: 'Always triggers',
  rows: 1,
  symbols: [
    { id: 'A', kind: 'regular' },
    { id: 'S', kind: 'scatter' },
  ],
  reels: [['S'], ['S'], ['S']],
  paylines: [[0, 0, 0]],
  paytable: [{ symbol: 'S', count: 3, pays: 5 }],
  freeSpins: { symbol: 'S', count: 3, spins: 3, multiplier: 2 },
});

function withFreeSpins(freeSpins: unknown): unknown {
  return {
    id: 'fs',
    name: 'FS',
    rows: 1,
    symbols: [
      { id: 'A', kind: 'regular' },
      { id: 'S', kind: 'scatter' },
    ],
    reels: [
      ['A', 'S'],
      ['A', 'S'],
      ['A', 'S'],
    ],
    paylines: [[0, 0, 0]],
    paytable: [{ symbol: 'A', count: 3, pays: 4 }],
    freeSpins,
  };
}

describe('free spins config', () => {
  it('defaults the multiplier to 1', () => {
    const config = parseGameConfig(withFreeSpins({ symbol: 'S', count: 3, spins: 10 }));
    expect(config.freeSpins?.multiplier).toBe(1);
  });

  it('must be triggered by a scatter', () => {
    expect(() => parseGameConfig(withFreeSpins({ symbol: 'A', count: 3, spins: 10 }))).toThrow(
      /free spins must be triggered by a scatter symbol/,
    );
  });

  it('cannot need more symbols than the screen holds', () => {
    expect(() => parseGameConfig(withFreeSpins({ symbol: 'S', count: 4, spins: 10 }))).toThrow(
      /the screen has only 3 positions/,
    );
  });
});

describe('round engine', () => {
  it('plays the free spins and applies the multiplier', () => {
    const outcome = createRoundEngine(alwaysTriggers)(createRng(1));
    expect(outcome.base.evaluation.winLineBets).toBe(5);
    expect(outcome.freeSpins?.spins).toHaveLength(3);
    expect(outcome.freeSpins?.multiplier).toBe(2);
    expect(outcome.freeSpins?.winLineBets).toBe(30);
    expect(outcome.winLineBets).toBe(35);
    expect(outcome.multiplier).toBe(35);
  });

  it('pays the round in cents, with each free spin itemised', () => {
    const round = playRound(alwaysTriggers, createRng(1), 100);
    expect(round.winCents).toBe(3500);
    expect(round.freeSpins?.winCents).toBe(3000);
    expect(round.freeSpins?.spins.map((s) => s.winCents)).toEqual([1000, 1000, 1000]);
  });

  it('does not trigger without enough scatters', () => {
    const config: GameConfig = parseGameConfig(withFreeSpins({ symbol: 'S', count: 3, spins: 10 }));
    const engine = createRoundEngine(config);
    const rng = createRng(5);
    for (let i = 0; i < 500; i++) {
      const outcome = engine(rng);
      const scatters = countSymbol(outcome.base.screen, 'S');
      expect(outcome.freeSpins === null).toBe(scatters < 3);
      if (outcome.freeSpins) expect(outcome.freeSpins.spins).toHaveLength(10);
    }
  });

  it('is reproducible: the same seed gives the same free spins', () => {
    const config = parseGameConfig(withFreeSpins({ symbol: 'S', count: 3, spins: 10 }));
    const run = (seed: number) => {
      const engine = createRoundEngine(config);
      const rng = createRng(seed);
      return Array.from({ length: 200 }, () => engine(rng).winLineBets);
    };
    expect(run(9)).toEqual(run(9));
  });

  it('leaves games without the feature exactly as before', () => {
    const config = parseGameConfig({
      ...(withFreeSpins(undefined) as object),
      freeSpins: undefined,
    });
    const outcome = createRoundEngine(config)(createRng(3));
    expect(outcome.freeSpins).toBeNull();
    expect(outcome.winLineBets).toBe(outcome.base.evaluation.winLineBets);
  });

  it('counts symbols anywhere on the screen', () => {
    expect(
      countSymbol(
        [
          ['S', 'A'],
          ['A', 'A'],
          ['S', 'S'],
        ],
        'S',
      ),
    ).toBe(3);
  });
});
