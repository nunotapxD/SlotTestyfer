import { existsSync, readFileSync } from 'node:fs';
import { parseGameConfig, type Evaluation } from '@slottestyfer/engine';
import { describe, expect, it } from 'vitest';
import {
  analyzeExact,
  certify,
  countCombinations,
  emptyStats,
  histogramBucket,
  mergeStats,
  planChunks,
  recordRound,
  runChunk,
  simulate,
  summarize,
  type Report,
} from '../src/index.js';

function loadGame(file: string) {
  const url = new URL(`../../../games/${file}`, import.meta.url);
  return parseGameConfig(JSON.parse(readFileSync(url, 'utf8')));
}

/**
 * 2 reels x 1 row, one payline. Only A A pays (4x). 4 combinations, one of them wins,
 * so everything can be worked out by hand: RTP = 4/4 = 100%, hit frequency = 25%.
 */
const coin = parseGameConfig({
  id: 'coin',
  name: 'Coin',
  rows: 1,
  symbols: [
    { id: 'A', kind: 'regular' },
    { id: 'B', kind: 'regular' },
  ],
  reels: [
    ['A', 'B'],
    ['A', 'B'],
  ],
  paylines: [[0, 0]],
  paytable: [{ symbol: 'A', count: 2, pays: 4 }],
});

function evaluation(winLineBets: number, lines: number): Evaluation {
  return {
    lineWins:
      winLineBets > 0
        ? [{ payline: 0, symbol: 'A', count: 3, pays: winLineBets, positions: [] }]
        : [],
    scatterWins: [],
    winLineBets,
    multiplier: winLineBets / lines,
  };
}

describe('stats', () => {
  it('buckets wins by multiple of the total bet', () => {
    expect([0, 0.5, 1, 1.9, 2, 4.99, 5, 19, 20, 500].map(histogramBucket)).toEqual([
      0, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
  });

  it('keeps running totals', () => {
    const stats = emptyStats(5);
    [0, 5, 0, 20, 10].forEach((win) => recordRound(stats, evaluation(win, 5)));
    expect(stats.rounds).toBe(5);
    expect(stats.totalWin).toBe(35);
    expect(stats.sumSquares).toBe(25 + 400 + 100);
    expect(stats.hits).toBe(3);
    expect(stats.maxWin).toBe(20);
    expect(stats.bySymbol).toEqual({ A: 35 });
    // multipliers 0, 1, 0, 4, 2
    expect(stats.histogram).toEqual([2, 0, 1, 2, 0, 0]);
  });

  it('merges to the same totals as recording everything in one place', () => {
    const wins = [0, 3, 7, 0, 0, 12, 1];
    const all = emptyStats(3);
    const left = emptyStats(3);
    const right = emptyStats(3);
    wins.forEach((win, i) => {
      recordRound(all, evaluation(win, 3));
      recordRound(i < 4 ? left : right, evaluation(win, 3));
    });
    expect(mergeStats(left, right)).toEqual(all);
    expect(mergeStats(right, left)).toEqual(all);
  });

  it('refuses to merge results from different games', () => {
    expect(() => mergeStats(emptyStats(3), emptyStats(5))).toThrow();
  });
});

describe('summarize', () => {
  it('computes RTP, hit frequency, max win and volatility', () => {
    const stats = emptyStats(1);
    // Wins of 0, 0, 2, 2 total bets: mean 1, sample variance 4/3.
    [0, 0, 2, 2].forEach((win) => recordRound(stats, evaluation(win, 1)));
    const report = summarize(stats);
    expect(report.rtp).toBe(1);
    expect(report.hitFrequency).toBe(0.5);
    expect(report.maxWin).toBe(2);
    expect(report.stdDev).toBeCloseTo(Math.sqrt(4 / 3), 12);
    expect(report.standardError).toBeCloseTo(Math.sqrt(4 / 3) / 2, 12);
    expect(report.interval.low).toBeLessThan(1);
    expect(report.interval.high).toBeGreaterThan(1);
  });

  it('refuses to summarize nothing', () => {
    expect(() => summarize(emptyStats(1))).toThrow();
  });
});

describe('certify', () => {
  const report = (rtp: number, standardError: number): Report => ({
    rounds: 1_000_000,
    rtp,
    rtpBySymbol: [],
    hitFrequency: 0.3,
    maxWin: 100,
    stdDev: standardError * 1000,
    standardError,
    interval: {
      confidence: 0.95,
      low: rtp - 1.96 * standardError,
      high: rtp + 1.96 * standardError,
    },
    histogram: [],
  });

  it('passes when the whole interval is inside target ± tolerance', () => {
    expect(certify(report(0.961, 0.001), 0.96, 0.005).status).toBe('PASS');
  });

  it('fails when the whole interval is outside', () => {
    expect(certify(report(0.95, 0.001), 0.96, 0.005).status).toBe('FAIL');
    expect(certify(report(0.975, 0.001), 0.96, 0.005).status).toBe('FAIL');
  });

  it('is inconclusive when the interval crosses a limit, and says how many rounds would settle it', () => {
    const verdict = certify(report(0.963, 0.002), 0.96, 0.005);
    expect(verdict.status).toBe('INCONCLUSIVE');
    // margin 0.002, stdDev 2: n = (1.96 * 2 / 0.002)^2 ≈ 3.84 million
    expect(verdict.roundsNeeded).toBeGreaterThan(3_800_000);
    expect(verdict.roundsNeeded).toBeLessThan(3_900_000);
  });

  it('gives no round estimate when the estimate itself is outside the range', () => {
    const verdict = certify(report(0.9665, 0.002), 0.96, 0.005);
    expect(verdict.status).toBe('INCONCLUSIVE');
    expect(verdict.roundsNeeded).toBeUndefined();
  });

  it('rejects a tolerance that is not positive', () => {
    expect(() => certify(report(0.96, 0.001), 0.96, 0)).toThrow(RangeError);
  });
});

describe('analyzeExact', () => {
  it('matches the hand calculation for a tiny game', () => {
    const { combinations, report } = analyzeExact(coin);
    expect(combinations).toBe(4);
    expect(report.rtp).toBe(1);
    expect(report.hitFrequency).toBe(0.25);
    expect(report.maxWin).toBe(4);
    // Population std dev of wins [4, 0, 0, 0]: sqrt(16/4 - 1) = sqrt(3).
    expect(report.stdDev).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('refuses games with too many combinations', () => {
    expect(countCombinations(coin)).toBe(4);
    expect(() => analyzeExact(coin, 3)).toThrow(RangeError);
  });
});

describe('planChunks', () => {
  it('splits the rounds into fixed-size chunks with their own seeds', () => {
    const chunks = planChunks(1_050_000, 42, 250_000);
    expect(chunks.map((c) => c.rounds)).toEqual([250_000, 250_000, 250_000, 250_000, 50_000]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(chunks.map((c) => c.seed)).size).toBe(5);
  });

  it('rejects invalid sizes', () => {
    expect(() => planChunks(0, 1)).toThrow(RangeError);
    expect(() => planChunks(10, 1, 0)).toThrow(RangeError);
  });
});

describe('simulate', () => {
  const demo = loadGame('fruits-demo.json');

  it('gives exactly the same result for the same seed', async () => {
    const a = await simulate(demo, { spins: 20_000, seed: 7, chunkSize: 5_000 });
    const b = await simulate(demo, { spins: 20_000, seed: 7, chunkSize: 5_000 });
    expect(a).toEqual(b);
  });

  it('adds up to the same totals as running the chunks one by one', async () => {
    const stats = await simulate(demo, { spins: 12_000, seed: 3, chunkSize: 5_000 });
    const byHand = planChunks(12_000, 3, 5_000)
      .map((c) => runChunk(demo, c.rounds, c.seed))
      .reduce(mergeStats);
    expect(stats).toEqual(byHand);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await simulate(demo, {
      spins: 3_000,
      seed: 1,
      chunkSize: 1_000,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1_000, 2_000, 3_000]);
  });

  it('agrees with the exact RTP within the confidence interval', async () => {
    const exact = analyzeExact(demo).report;
    const report = summarize(await simulate(demo, { spins: 300_000, seed: 2026 }));
    expect(exact.rtp).toBeGreaterThan(report.interval.low);
    expect(exact.rtp).toBeLessThan(report.interval.high);
    expect(Math.abs(report.hitFrequency - exact.hitFrequency)).toBeLessThan(0.005);
  });

  // The worker runs compiled JavaScript, so this needs `npm run build` (CI builds before testing).
  const workerUrl = new URL('../dist/worker.js', import.meta.url);
  it.skipIf(!existsSync(workerUrl))('gives the same result with worker threads', async () => {
    const options = { spins: 40_000, seed: 11, chunkSize: 5_000 };
    const sequential = await simulate(demo, options);
    const parallel = await simulate(demo, { ...options, workers: 3, workerUrl });
    expect(parallel).toEqual(sequential);
  });
});
