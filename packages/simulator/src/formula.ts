/**
 * Exact RTP by formula, without playing every screen.
 *
 * Reels are independent and every stop is equally likely, so on any payline the symbol shown by
 * reel r follows that reel's symbol frequencies, whatever the row. Every payline therefore has the
 * same expected prize, and the line RTP is the expected prize of ONE line: an enumeration over
 * symbols per reel (e.g. 6^5 = 7,776 cases for 5 reels) instead of every screen (millions).
 *
 * Scatters pay by how many are visible anywhere, so we build, for each reel, the distribution of
 * how many scatters its window shows, and combine the reels by convolution.
 *
 * Free spins use the same reels and do not retrigger, so each free spin is worth the base RTP
 * times the multiplier: RTP = base x (1 + P(trigger) x spins x multiplier).
 *
 * This gives the RTP and its breakdown exactly. Hit frequency and volatility depend on how the
 * paylines overlap, so for those we still simulate (or enumerate small games in exact.ts).
 */
import { createEvaluator, type GameConfig } from '@slottestyfer/engine';

export interface RtpFormula {
  /** Total RTP. */
  readonly rtp: number;
  /** RTP of one base spin: lines + scatters. */
  readonly baseRtp: number;
  /** Line wins in the base spin. */
  readonly lines: number;
  /** Scatter wins in the base spin. */
  readonly scatters: number;
  /** Everything won during free spins. */
  readonly freeSpins: number;
  /** Probability that a round triggers free spins (0 without the feature). */
  readonly triggerProbability: number;
}

/** Symbol -> probability of that symbol on a reel's payline position. */
export type ReelDistribution = ReadonlyMap<string, number>;

export function reelDistribution(strip: readonly string[]): ReelDistribution {
  const counts = new Map<string, number>();
  for (const symbol of strip) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return new Map([...counts].map(([symbol, count]) => [symbol, count / strip.length]));
}

/** A one-row, one-payline version of the game with only line prizes, to evaluate one line. */
function lineOnlyGame(config: GameConfig): GameConfig {
  const scatters = new Set(config.symbols.filter((s) => s.kind === 'scatter').map((s) => s.id));
  return {
    ...config,
    rows: 1,
    paylines: [config.reels.map(() => 0)],
    paytable: config.paytable.filter((p) => !scatters.has(p.symbol)),
    freeSpins: undefined,
  };
}

/**
 * Expected prize of one payline (in line bets) when reel r shows symbols with probabilities
 * reels[r]. Enumerates one symbol per reel, weighting each case by its probability.
 */
export function expectedLinePay(config: GameConfig, reels: readonly ReelDistribution[]): number {
  const evaluate = createEvaluator(lineOnlyGame(config));
  const options = reels.map((dist) => [...dist].filter(([, p]) => p > 0));
  const screen: string[][] = reels.map(() => ['']);
  let expected = 0;

  const walk = (reel: number, probability: number): void => {
    if (reel === options.length) {
      expected += probability * evaluate(screen).winLineBets;
      return;
    }
    for (const [symbol, p] of options[reel] ?? []) {
      const column = screen[reel];
      if (column) column[0] = symbol;
      walk(reel + 1, probability * p);
    }
  };
  walk(0, 1);
  return expected;
}

/** P[k] = probability that exactly k of `symbol` are visible on the screen. */
export function symbolCountDistribution(config: GameConfig, symbol: string): number[] {
  let total = [1];
  for (const strip of config.reels) {
    const perReel = new Array<number>(config.rows + 1).fill(0);
    for (let stop = 0; stop < strip.length; stop++) {
      let count = 0;
      for (let row = 0; row < config.rows; row++) {
        if (strip[(stop + row) % strip.length] === symbol) count++;
      }
      perReel[count] = (perReel[count] ?? 0) + 1 / strip.length;
    }
    // Convolution: the count so far plus this reel's count.
    const next = new Array<number>(total.length + config.rows).fill(0);
    total.forEach((p, i) => {
      perReel.forEach((q, j) => {
        next[i + j] = (next[i + j] ?? 0) + p * q;
      });
    });
    total = next;
  }
  return total;
}

/** Prize for n symbols: the best one defined for n or fewer (the engine's rule). */
function bestPay(config: GameConfig, symbol: string, n: number): number {
  let best = 0;
  for (const pay of config.paytable) {
    if (pay.symbol === symbol && pay.count <= n && pay.pays > best) best = pay.pays;
  }
  return best;
}

export function computeRtp(config: GameConfig): RtpFormula {
  const lines = expectedLinePay(config, config.reels.map(reelDistribution));

  let scatters = 0;
  for (const symbol of config.symbols.filter((s) => s.kind === 'scatter')) {
    symbolCountDistribution(config, symbol.id).forEach((p, n) => {
      scatters += p * bestPay(config, symbol.id, n);
    });
  }

  const baseRtp = lines + scatters;
  const feature = config.freeSpins;
  const triggerProbability = feature
    ? symbolCountDistribution(config, feature.symbol)
        .slice(feature.count)
        .reduce((sum, p) => sum + p, 0)
    : 0;
  const freeSpins = feature ? triggerProbability * feature.spins * feature.multiplier * baseRtp : 0;

  return { rtp: baseRtp + freeSpins, baseRtp, lines, scatters, freeSpins, triggerProbability };
}
