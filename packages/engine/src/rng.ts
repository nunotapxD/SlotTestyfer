/**
 * Seeded pseudo-random number generation.
 *
 * Every random decision in the engine goes through an {@link Rng}. With the same seed the
 * engine produces exactly the same games, which makes simulations reproducible and auditable.
 *
 * Algorithm: mulberry32 (32-bit state, period 2^32). It is fast and passes the statistical
 * tests that matter for game simulation. It is NOT cryptographically secure, so it must not be
 * used for real-money games, which need a certified RNG.
 */

const UINT32_RANGE = 2 ** 32;

export interface Rng {
  /** Next unsigned 32-bit integer in [0, 2^32). */
  nextUint32(): number;
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive), with no modulo bias. */
  nextInt(maxExclusive: number): number;
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32_RANGE) {
    throw new RangeError(`${name} must be an integer in [0, 2^32), got ${value}`);
  }
}

/** Creates a mulberry32 generator. The seed must be an integer in [0, 2^32). */
export function createRng(seed: number): Rng {
  assertUint32(seed, 'seed');
  let state = seed;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
      throw new RangeError(`maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
    }
    // Rejection sampling: `r % n` alone favours small results whenever n does not divide 2^32.
    // Values at or above `limit` are discarded so every result has the same probability.
    const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
    let r = nextUint32();
    while (r >= limit) {
      r = nextUint32();
    }
    return r % maxExclusive;
  };

  return {
    nextUint32,
    next: () => nextUint32() / UINT32_RANGE,
    nextInt,
  };
}

/**
 * Derives an independent seed from a base seed and an index (for example a worker number),
 * so parallel simulations do not share or overlap sequences. Uses the murmur3 finaliser.
 */
export function deriveSeed(baseSeed: number, index: number): number {
  assertUint32(baseSeed, 'baseSeed');
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`index must be a non-negative integer, got ${index}`);
  }
  let z = (baseSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}
