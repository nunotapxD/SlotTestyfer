import { describe, expect, it } from 'vitest';
import { createRng, parseGameConfig, screenFromStops, spin } from '../src/index.js';

/** 3 reels x 3 rows. Strips of different lengths so wrapping is tested on each. */
const config = parseGameConfig({
  id: 'spin-test',
  name: 'Spin test',
  rows: 3,
  symbols: [
    { id: 'A', kind: 'regular' },
    { id: 'B', kind: 'regular' },
    { id: 'C', kind: 'regular' },
    { id: 'D', kind: 'regular' },
    { id: 'E', kind: 'regular' },
  ],
  reels: [
    ['A', 'B', 'C', 'D', 'E'],
    ['E', 'D', 'C', 'B'],
    ['A', 'C', 'E', 'B', 'D', 'A'],
  ],
  paylines: [[1, 1, 1]],
  paytable: [{ symbol: 'A', count: 3, pays: 1 }],
});

describe('screenFromStops', () => {
  it('shows consecutive symbols from each stop, one column per reel', () => {
    expect(screenFromStops(config, [0, 0, 0])).toEqual([
      ['A', 'B', 'C'],
      ['E', 'D', 'C'],
      ['A', 'C', 'E'],
    ]);
  });

  it('wraps around the end of the strip', () => {
    expect(screenFromStops(config, [4, 3, 5])).toEqual([
      ['E', 'A', 'B'],
      ['B', 'E', 'D'],
      ['A', 'A', 'C'],
    ]);
  });

  it('rejects the wrong number of stops', () => {
    expect(() => screenFromStops(config, [0, 0])).toThrow(RangeError);
  });

  it('rejects stops outside the strip', () => {
    expect(() => screenFromStops(config, [0, 4, 0])).toThrow(RangeError);
    expect(() => screenFromStops(config, [-1, 0, 0])).toThrow(RangeError);
    expect(() => screenFromStops(config, [0.5, 0, 0])).toThrow(RangeError);
  });
});

describe('spin', () => {
  it('returns one stop per reel, each inside its strip', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const { stops } = spin(config, rng);
      expect(stops).toHaveLength(3);
      stops.forEach((stop, reel) => {
        expect(stop).toBeGreaterThanOrEqual(0);
        expect(stop).toBeLessThan(config.reels[reel]?.length ?? 0);
      });
    }
  });

  it('returns the screen that matches its stops, so any spin can be replayed', () => {
    const rng = createRng(99);
    for (let i = 0; i < 100; i++) {
      const result = spin(config, rng);
      expect(result.screen).toEqual(screenFromStops(config, result.stops));
    }
  });

  it('gives the same spins for the same seed', () => {
    const run = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 50 }, () => spin(config, rng).stops);
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('lands on every stop of a reel equally often (chi-square)', () => {
    const rng = createRng(2026);
    const spins = 60_000;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < spins; i++) {
      const stop = spin(config, rng).stops[2] ?? 0;
      counts[stop] = (counts[stop] ?? 0) + 1;
    }
    const expected = spins / 6;
    const chiSquare = counts.reduce(
      (sum, observed) => sum + (observed - expected) ** 2 / expected,
      0,
    );
    // Critical value for 5 degrees of freedom at p = 0.001.
    expect(chiSquare).toBeLessThan(20.515);
  });
});
