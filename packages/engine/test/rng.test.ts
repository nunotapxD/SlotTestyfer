import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from '../src/index.js';

function take(seed: number, count: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.nextUint32());
}

describe('createRng', () => {
  it('gives the same sequence for the same seed', () => {
    expect(take(42, 1000)).toEqual(take(42, 1000));
  });

  it('gives different sequences for different seeds', () => {
    expect(take(42, 10)).not.toEqual(take(43, 10));
  });

  it('matches the reference mulberry32 output for seed 42', () => {
    // If this changes, every saved simulation changes too: bump ENGINE_VERSION.
    expect(take(42, 5)).toEqual([2581720956, 1925393290, 3661312704, 2876485805, 750819978]);
  });

  it('rejects seeds that are not 32-bit unsigned integers', () => {
    expect(() => createRng(-1)).toThrow(RangeError);
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(2 ** 32)).toThrow(RangeError);
  });

  it('returns floats in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('nextInt', () => {
  it('stays within [0, max)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.nextInt(7);
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
    }
  });

  it('always returns 0 when max is 1', () => {
    const rng = createRng(1);
    expect(rng.nextInt(1)).toBe(0);
  });

  it('rejects invalid bounds', () => {
    const rng = createRng(1);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(2.5)).toThrow(RangeError);
  });

  it('is uniform (chi-square test on a six-sided die)', () => {
    const rng = createRng(2026);
    const draws = 60_000;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < draws; i++) {
      const face = rng.nextInt(6);
      counts[face] = (counts[face] ?? 0) + 1;
    }
    const expected = draws / 6;
    const chiSquare = counts.reduce(
      (sum, observed) => sum + (observed - expected) ** 2 / expected,
      0,
    );
    // Critical value for 5 degrees of freedom at p = 0.001. The seed is fixed, so this never flakes.
    expect(chiSquare).toBeLessThan(20.515);
  });
});

describe('deriveSeed', () => {
  it('is deterministic', () => {
    expect(deriveSeed(42, 3)).toBe(deriveSeed(42, 3));
  });

  it('gives a distinct seed for each index', () => {
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(42, i)));
    expect(seeds.size).toBe(1000);
  });

  it('produces valid seeds for createRng', () => {
    expect(() => createRng(deriveSeed(0xffffffff, 999))).not.toThrow();
  });

  it('rejects negative indices', () => {
    expect(() => deriveSeed(42, -1)).toThrow(RangeError);
  });
});
