import { readFileSync } from 'node:fs';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { computeRtp } from '@slottestyfer/simulator/core';
import { describe as group, expect, it } from 'vitest';
import {
  analysisToJson,
  analyzeGame,
  compareGames,
  comparisonToCsv,
  convergence,
  describe,
  longestZeroRun,
  maxDrawdown,
  percentileSorted,
  roundsToCsv,
  sampleRounds,
  simulateSessions,
  summarizeInWords,
  survivalToCsv,
  unusualStreakLength,
  volatilityBand,
} from '../src/index.js';

const load = (file: string): GameConfig =>
  parseGameConfig(
    JSON.parse(readFileSync(new URL(`../../../games/${file}.json`, import.meta.url), 'utf8')),
  );

/** One reel, one row, one line. Every round pays `pays` line bets (0 = always loses). */
function fixedGame(pays: number): GameConfig {
  return parseGameConfig({
    id: `fixed-${pays}`,
    name: `Fixed ${pays}`,
    rows: 1,
    symbols: [
      { id: 'A', kind: 'regular' },
      { id: 'B', kind: 'regular' },
    ],
    reels: [['A']],
    paylines: [[0]],
    paytable: [{ symbol: pays > 0 ? 'A' : 'B', count: 1, pays: Math.max(1, pays) }],
  });
}

group('descriptive statistics', () => {
  it('interpolates percentiles between ranks', () => {
    const sorted = [1, 2, 3, 4];
    expect(percentileSorted(sorted, 0)).toBe(1);
    expect(percentileSorted(sorted, 0.5)).toBe(2.5);
    expect(percentileSorted(sorted, 0.9)).toBeCloseTo(3.7, 12);
    expect(percentileSorted(sorted, 1)).toBe(4);
    expect(() => percentileSorted([], 0.5)).toThrow(RangeError);
    expect(() => percentileSorted(sorted, 1.5)).toThrow(RangeError);
  });

  it('describes a small sample', () => {
    const d = describe([2, 0, 2, 0]);
    expect(d.count).toBe(4);
    expect(d.mean).toBe(1);
    expect(d.stdDev).toBeCloseTo(Math.sqrt(4 / 3), 12);
    expect(d.median).toBe(1);
    expect(d.min).toBe(0);
    expect(d.max).toBe(2);
    expect(d.zeroShare).toBe(0.5);
  });

  it('finds the longest run without a win', () => {
    expect(longestZeroRun([1, 0, 0, 3, 0, 0, 0, 2])).toBe(3);
    expect(longestZeroRun([0, 0])).toBe(2);
    expect(longestZeroRun([1, 2])).toBe(0);
  });

  it('measures the worst drawdown betting 1 per round', () => {
    // Balances: -1, -2, 0, -1. Worst fall: from the start (0) to -2.
    expect(maxDrawdown([0, 0, 3, 0])).toEqual({ depth: 2, peakRound: -1, troughRound: 1 });
    // Balances: 1, 0, -1, 4, 3. Worst fall: from 1 (round 0) to -1 (round 2).
    expect(maxDrawdown([2, 0, 0, 6, 0])).toEqual({ depth: 2, peakRound: 0, troughRound: 2 });
  });

  it('says which losing streak would be unusual', () => {
    // h = 0.5 over 100 rounds: 50 expected starts; need 50 x 0.5^L < 0.01, so L = 13.
    expect(unusualStreakLength(0.5, 100)).toBe(13);
    expect(unusualStreakLength(0.5, 1_000_000)).toBeGreaterThan(unusualStreakLength(0.5, 100));
    expect(unusualStreakLength(0, 100)).toBe(Infinity);
  });

  it('names volatility bands', () => {
    expect([1, 2, 5.9, 6, 14, 15].map(volatilityBand)).toEqual([
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'very high',
    ]);
  });
});

group('convergence', () => {
  it('ends at the full sample with the overall mean', () => {
    const wins = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? 0 : 2));
    const points = convergence(wins, 20);
    const last = points[points.length - 1];
    expect(last?.rounds).toBe(1000);
    expect(last?.rtp).toBe(1);
    expect(points.every((p, i) => i === 0 || p.rounds > (points[i - 1]?.rounds ?? 0))).toBe(true);
    expect(points.every((p) => p.low <= p.rtp && p.rtp <= p.high)).toBe(true);
  });

  it('has no width when every round is the same', () => {
    expect(convergence([1, 1, 1, 1])).toEqual([{ rounds: 4, rtp: 1, low: 1, high: 1 }]);
  });
});

group('sessions', () => {
  it('a game that never pays uses up 100 credits in exactly 100 rounds', () => {
    const result = simulateSessions(fixedGame(0), { seed: 1, sessions: 10, maxRounds: 1000 });
    expect(result.length.median).toBe(100);
    expect(result.bustedShare).toBe(1);
    expect(result.checkpoints).toEqual([
      { rounds: 100, ahead: 0, busted: 0 },
      { rounds: 500, ahead: 0, busted: 1 },
      { rounds: 1000, ahead: 0, busted: 1 },
    ]);
    expect(result.survival[99]).toBe(1);
    expect(result.survival[100]).toBe(0);
    expect(result.drawdown.median).toBe(100);
    expect(result.finalBalance.max).toBe(0);
    expect(result.trajectories[0]?.slice(0, 3)).toEqual([99, 98, 97]);
  });

  it('a game that always pays double keeps every player ahead', () => {
    const result = simulateSessions(fixedGame(2), { seed: 1, sessions: 10, maxRounds: 500 });
    expect(result.length.median).toBe(500);
    expect(result.bustedShare).toBe(0);
    expect(result.checkpoints.map((c) => c.ahead)).toEqual([1, 1]);
    expect(result.finalBalance.mean).toBe(600);
    expect(result.drawdown.max).toBe(0);
  });

  it('is reproducible from the seed', () => {
    const game = load('fruits-96');
    const a = simulateSessions(game, { seed: 5, sessions: 50, maxRounds: 200 });
    const b = simulateSessions(game, { seed: 5, sessions: 50, maxRounds: 200 });
    expect(a).toEqual(b);
  });
});

group('game analysis', () => {
  const game = load('fruits-5x3');
  const analysis = analyzeGame(game, { seed: 42, rounds: 20_000, sessions: 100, maxRounds: 200 });

  it('keeps the rounds consistent with the simulator totals', () => {
    const sample = sampleRounds(game, 5000, 3);
    const total = sample.wins.reduce((a, b) => a + b, 0);
    expect(total * game.paylines.length).toBeCloseTo(sample.stats.totalWin, 6);
    expect(sample.triggered.reduce((a, b) => a + b, 0)).toBe(sample.stats.triggers);
  });

  it('includes the exact RTP and the sampled report', () => {
    expect(analysis.exact.rtp).toBe(computeRtp(game).rtp);
    expect(analysis.report.rounds).toBe(20_000);
    expect(analysis.convergence[analysis.convergence.length - 1]?.rounds).toBe(20_000);
    expect(analysis.sessions.sessions).toBe(100);
  });

  it('compares games metric by metric', () => {
    const other = analyzeGame(load('fruits-88'), {
      seed: 42,
      rounds: 5000,
      sessions: 50,
      maxRounds: 200,
    });
    const rows = compareGames([analysis, other]);
    expect(rows.every((r) => r.values.length === 2)).toBe(true);
    expect(rows.find((r) => r.metric === 'RTP (exact)')?.values[1]).toBeCloseTo(0.87975, 10);
    const csv = comparisonToCsv([analysis.game, other.game], rows).split('\n');
    expect(csv[0]).toBe('metric,unit,fruits-5x3,fruits-88');
  });

  it('describes the game in words', () => {
    const words = summarizeInWords(analysis);
    expect(words[0]).toContain('Fruits 5x3 pays back');
    expect(words.join(' ')).toContain('credits');
  });

  it('exports JSON and CSV', () => {
    expect(JSON.parse(analysisToJson([analysis])).analyses).toHaveLength(1);
    const rounds = roundsToCsv(sampleRounds(game, 10, 1))
      .trim()
      .split('\n');
    expect(rounds).toHaveLength(11);
    expect(rounds[0]).toBe('round,win,free_spins');
    expect(survivalToCsv(analysis).split('\n')[0]).toBe('round,still_playing');
  });
});
