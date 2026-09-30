/**
 * Property-based tests for the simulator: merging totals must not depend on how rounds are split
 * between workers, and the exact RTP formula must match playing every combination, for any small
 * random game.
 */
import fc from 'fast-check';
import { createRng, parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { describe, expect, it } from 'vitest';
import { analyzeExact, computeRtp, mergeStats, runChunk, summarize } from '../src/core.js';

const SYMBOLS = ['A', 'B', 'W', 'S'] as const;

/** A random small game (3 reels, up to 6 stops) so full enumeration stays instant. */
const smallGameArb = fc
  .record({
    rows: fc.integer({ min: 1, max: 3 }),
    stripLength: fc.integer({ min: 3, max: 6 }),
    seed: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    lines: fc.integer({ min: 1, max: 4 }),
    pays: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 4, maxLength: 4 }),
  })
  .map(({ rows, stripLength, seed, lines, pays }): GameConfig => {
    const rng = createRng(seed);
    const pick = () => SYMBOLS[rng.nextInt(SYMBOLS.length)] ?? 'A';
    return parseGameConfig({
      id: 'prop',
      name: 'Property game',
      rows: Math.min(rows, stripLength),
      symbols: [
        { id: 'A', kind: 'regular' },
        { id: 'B', kind: 'regular' },
        { id: 'W', kind: 'wild' },
        { id: 'S', kind: 'scatter' },
      ],
      reels: Array.from({ length: 3 }, () => Array.from({ length: stripLength }, pick)),
      paylines: Array.from({ length: lines }, () =>
        Array.from({ length: 3 }, () => rng.nextInt(Math.min(rows, stripLength))),
      ),
      paytable: [
        { symbol: 'A', count: 2, pays: pays[0] ?? 1 },
        { symbol: 'B', count: 3, pays: pays[1] ?? 1 },
        { symbol: 'W', count: 3, pays: pays[2] ?? 1 },
        { symbol: 'S', count: 2, pays: pays[3] ?? 1 },
      ],
    });
  });

describe('simulator properties', () => {
  it('the exact RTP formula equals full enumeration for any small game', () => {
    fc.assert(
      fc.property(smallGameArb, (game) => {
        expect(computeRtp(game).rtp).toBeCloseTo(analyzeExact(game).report.rtp, 12);
      }),
      { numRuns: 150 },
    );
  });

  it('merging totals gives the same result in any order', () => {
    fc.assert(
      fc.property(
        smallGameArb,
        fc.array(fc.integer({ min: 0, max: 2 ** 32 - 1 }), { minLength: 3, maxLength: 3 }),
        (game, [s1 = 0, s2 = 0, s3 = 0]) => {
          const [a, b, c] = [s1, s2, s3].map((seed) => runChunk(game, 200, seed));
          if (!a || !b || !c) return;
          expect(mergeStats(mergeStats(a, b), c)).toEqual(mergeStats(a, mergeStats(c, b)));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('a report stays within its own bounds', () => {
    fc.assert(
      fc.property(smallGameArb, fc.integer({ min: 0, max: 2 ** 32 - 1 }), (game, seed) => {
        const report = summarize(runChunk(game, 500, seed));
        expect(report.rtp).toBeGreaterThanOrEqual(0);
        expect(report.hitFrequency).toBeGreaterThanOrEqual(0);
        expect(report.hitFrequency).toBeLessThanOrEqual(1);
        expect(report.interval.low).toBeLessThanOrEqual(report.rtp);
        expect(report.interval.high).toBeGreaterThanOrEqual(report.rtp);
        const shares = report.histogram.reduce((sum, bucket) => sum + bucket.share, 0);
        expect(shares).toBeCloseTo(1, 12);
        const parts = report.rtpByFeature.lines + report.rtpByFeature.scatters;
        expect(parts).toBeCloseTo(report.rtp, 12);
      }),
      { numRuns: 100 },
    );
  });
});
