import { readFileSync } from 'node:fs';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { describe, expect, it } from 'vitest';
import {
  analyzeExact,
  certify,
  certifyExact,
  computeRtp,
  reelDistribution,
  reportToCsv,
  simulate,
  summarize,
  symbolCountDistribution,
  tuneRtp,
} from '../src/index.js';

const load = (file: string): GameConfig =>
  parseGameConfig(
    JSON.parse(readFileSync(new URL(`../../../games/${file}.json`, import.meta.url), 'utf8')),
  );

const fruits96 = load('fruits-96');
const fruits88 = load('fruits-88');
const fruitsDemo = load('fruits-demo');
const fruits5x3 = load('fruits-5x3');

describe('computeRtp (exact RTP by formula)', () => {
  it.each([
    ['fruits-demo', fruitsDemo],
    ['fruits-96', fruits96],
    ['fruits-88', fruits88],
  ])('matches playing every combination of %s', (_name, game) => {
    const formula = computeRtp(game);
    const enumeration = analyzeExact(game).report;
    expect(formula.rtp).toBeCloseTo(enumeration.rtp, 12);
    expect(formula.lines).toBeCloseTo(enumeration.rtpByFeature.lines, 12);
    expect(formula.scatters).toBeCloseTo(enumeration.rtpByFeature.scatters, 12);
    expect(formula.freeSpins).toBe(0);
  });

  it('adds free spins as base RTP x trigger chance x spins x multiplier', () => {
    const f = computeRtp(fruits5x3);
    const feature = fruits5x3.freeSpins;
    expect(feature).toBeDefined();
    expect(f.freeSpins).toBeCloseTo(
      f.baseRtp * f.triggerProbability * (feature?.spins ?? 0) * (feature?.multiplier ?? 0),
      12,
    );
    expect(f.rtp).toBeCloseTo(f.baseRtp + f.freeSpins, 12);
  });

  it('agrees with a simulation of a game with free spins', async () => {
    const f = computeRtp(fruits5x3);
    const report = summarize(await simulate(fruits5x3, { spins: 300_000, seed: 2026 }));
    expect(Math.abs(report.rtp - f.rtp)).toBeLessThan(4 * report.standardError);
    expect(Math.abs(report.featureFrequency - f.triggerProbability)).toBeLessThan(0.0015);
  });

  it('computes reel frequencies and scatter counts by hand', () => {
    expect([...reelDistribution(['A', 'B', 'A', 'A'])]).toEqual([
      ['A', 0.75],
      ['B', 0.25],
    ]);
    // 2 reels, 1 row, S on 1 of 2 stops each: P(0) = 1/4, P(1) = 1/2, P(2) = 1/4.
    const coin = parseGameConfig({
      id: 'coin',
      name: 'Coin',
      rows: 1,
      symbols: [
        { id: 'A', kind: 'regular' },
        { id: 'S', kind: 'scatter' },
      ],
      reels: [
        ['A', 'S'],
        ['A', 'S'],
      ],
      paylines: [[0, 0]],
      paytable: [{ symbol: 'S', count: 2, pays: 3 }],
    });
    expect(symbolCountDistribution(coin, 'S')).toEqual([0.25, 0.5, 0.25]);
    // Only S S pays: 3x the total bet a quarter of the time.
    expect(computeRtp(coin).rtp).toBe(0.75);
  });
});

describe('tuneRtp', () => {
  it('brings a game to the target RTP by changing regular symbols only', () => {
    const result = tuneRtp(fruits5x3, { target: 0.9, tolerance: 0.0005 });
    expect(result.reached).toBe(true);
    expect(Math.abs(result.rtp - 0.9)).toBeLessThanOrEqual(0.0005);
    expect(computeRtp(result.config).rtp).toBeCloseTo(result.rtp, 12);

    result.config.reels.forEach((strip, r) => {
      const original = fruits5x3.reels[r] ?? [];
      expect(strip).toHaveLength(original.length);
      // Scatters and wilds stay exactly where they were.
      strip.forEach((symbol, i) => {
        if (['STAR', 'WILD'].includes(original[i] ?? '')) expect(symbol).toBe(original[i]);
      });
    });
    expect(computeRtp(result.config).triggerProbability).toBe(
      computeRtp(fruits5x3).triggerProbability,
    );
  });

  it('stops without changes when the game is already on target', () => {
    const rtp = computeRtp(fruits96).rtp;
    const result = tuneRtp(fruits96, { target: rtp, tolerance: 0.001 });
    expect(result.steps).toEqual([]);
    expect(result.config.reels).toEqual(fruits96.reels);
  });

  it('reports when one symbol change is too coarse to reach the tolerance', () => {
    // 3 reels of 20 stops: each change moves the RTP by about 1 point.
    const result = tuneRtp(fruitsDemo, { target: 0.96, tolerance: 0.0001 });
    expect(result.reached).toBe(false);
    expect(Math.abs(result.rtp - 0.96)).toBeLessThan(Math.abs(result.startRtp - 0.96));
  });
});

describe('golden runs', () => {
  // If these change, the engine or the simulator changed behaviour for the same seed.
  it('fruits-96, 1,000,000 rounds, seed 42', async () => {
    const stats = await simulate(fruits96, { spins: 1_000_000, seed: 42 });
    expect({
      rounds: stats.rounds,
      totalWin: stats.totalWin,
      sumSquares: stats.sumSquares,
      hits: stats.hits,
      maxWin: stats.maxWin,
    }).toEqual({
      rounds: 1_000_000,
      totalWin: 4_793_420,
      sumSquares: 135_954_350,
      hits: 528_996,
      maxWin: 220,
    });
  });

  it('fruits-5x3 with free spins, 200,000 rounds, seed 42', async () => {
    const stats = await simulate(fruits5x3, { spins: 200_000, seed: 42 });
    expect({
      totalWin: stats.totalWin,
      sumSquares: stats.sumSquares,
      hits: stats.hits,
      maxWin: stats.maxWin,
      triggers: stats.triggers,
      freeSpinsWin: stats.freeSpinsWin,
    }).toEqual({
      totalWin: 3_855_165,
      sumSquares: 1_026_944_425,
      hits: 102_805,
      maxWin: 2425,
      triggers: 1446,
      freeSpinsWin: 945_225,
    });
  });
});

describe('certification of the example games', () => {
  it('fruits-96 passes and fruits-88 fails a 96% ± 0.5% check', async () => {
    const pass = summarize(await simulate(fruits96, { spins: 2_000_000, seed: 1 }));
    const fail = summarize(await simulate(fruits88, { spins: 2_000_000, seed: 1 }));
    expect(certify(pass, 0.96, 0.005).status).toBe('PASS');
    expect(certify(fail, 0.96, 0.005).status).toBe('FAIL');
  });

  it('gives the same verdicts from the exact RTP', () => {
    expect(certifyExact(computeRtp(fruits96).rtp, 0.96, 0.005).status).toBe('PASS');
    expect(certifyExact(computeRtp(fruits88).rtp, 0.96, 0.005).status).toBe('FAIL');
    expect(certifyExact(computeRtp(fruits5x3).rtp, 0.96, 0.005).status).toBe('PASS');
  });
});

describe('reportToCsv', () => {
  it('writes one section,name,value table', () => {
    const { report } = analyzeExact(fruits96);
    const csv = reportToCsv(report, certifyExact(report.rtp, 0.96, 0.005), {
      game: 'fruits-96',
    });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('section,name,value');
    expect(lines).toContain('run,game,fruits-96');
    expect(lines).toContain('verdict,status,PASS');
    expect(lines).toContain(`summary,rtp,${report.rtp}`);
    expect(lines.filter((l) => l.startsWith('histogram_rounds,'))).toHaveLength(6);
  });

  it('quotes values that contain commas or quotes', () => {
    const { report } = analyzeExact(fruits96);
    const csv = reportToCsv(report, null, { note: 'a, "b"' });
    expect(csv).toContain('run,note,"a, ""b"""');
  });
});
