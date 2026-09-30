import { describe, expect, it } from 'vitest';
import {
  createRng,
  evaluate,
  parseGameConfig,
  playRound,
  screenFromStops,
  type Screen,
} from '../src/index.js';

/**
 * 5 reels x 3 rows, 4 paylines. C never pays, so it is used as filler.
 * A pays for 3 and 5 but not 4, to test the "best prize for n or fewer" rule.
 */
const config = parseGameConfig({
  id: 'evaluate-test',
  name: 'Evaluate test',
  rows: 3,
  symbols: [
    { id: 'A', kind: 'regular' },
    { id: 'B', kind: 'regular' },
    { id: 'C', kind: 'regular' },
    { id: 'W', kind: 'wild' },
    { id: 'S', kind: 'scatter' },
  ],
  reels: Array.from({ length: 5 }, () => ['A', 'B', 'C', 'W', 'S']),
  paylines: [
    [1, 1, 1, 1, 1], // 0: middle
    [0, 0, 0, 0, 0], // 1: top
    [2, 2, 2, 2, 2], // 2: bottom
    [0, 1, 2, 1, 0], // 3: V
  ],
  paytable: [
    { symbol: 'A', count: 3, pays: 10 },
    { symbol: 'A', count: 5, pays: 50 },
    { symbol: 'B', count: 3, pays: 5 },
    { symbol: 'B', count: 4, pays: 15 },
    { symbol: 'B', count: 5, pays: 40 },
    { symbol: 'W', count: 3, pays: 100 },
    { symbol: 'W', count: 5, pays: 1000 },
    { symbol: 'S', count: 3, pays: 2 },
    { symbol: 'S', count: 5, pays: 20 },
  ],
});

/** Writes a screen the way it looks (one line per row) and converts it to screen[reel][row]. */
function screenOf(top: string, middle: string, bottom: string): Screen {
  const rows = [top, middle, bottom].map((row) => row.split(' '));
  return Array.from({ length: 5 }, (_, reel) => rows.map((row) => row[reel] ?? ''));
}

const FILLER = 'C C C C C';

function lineWin(middle: string) {
  const result = evaluate(config, screenOf(FILLER, middle, FILLER));
  return { result, win: result.lineWins[0] };
}

describe('line wins', () => {
  it('pays nothing when no line matches', () => {
    const result = evaluate(config, screenOf('A B C A B', 'B C A C A', 'C A B B C'));
    expect(result.lineWins).toEqual([]);
    expect(result.scatterWins).toEqual([]);
    expect(result.winLineBets).toBe(0);
    expect(result.multiplier).toBe(0);
  });

  it('pays three of a kind from the leftmost reel', () => {
    const { result, win } = lineWin('A A A C C');
    expect(win).toEqual({
      payline: 0,
      symbol: 'A',
      count: 3,
      pays: 10,
      wilds: 0,
      positions: [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    });
    // 10 line bets over 4 paylines = 2.5x the total bet.
    expect(result.winLineBets).toBe(10);
    expect(result.multiplier).toBe(2.5);
  });

  it('pays the best defined prize when the exact count has none', () => {
    const { win } = lineWin('A A A A C');
    expect(win?.count).toBe(4);
    expect(win?.pays).toBe(10);
  });

  it('pays five of a kind', () => {
    expect(lineWin('A A A A A').win?.pays).toBe(50);
  });

  it('stops at the first symbol that does not match', () => {
    expect(lineWin('A A B A A').result.lineWins).toEqual([]);
  });

  it('needs the match to start on the leftmost reel', () => {
    expect(lineWin('C A A A A').result.lineWins).toEqual([]);
  });

  it('lets a wild substitute a regular symbol', () => {
    const { win } = lineWin('A W A C C');
    expect(win?.symbol).toBe('A');
    expect(win?.count).toBe(3);
    expect(win?.pays).toBe(10);
  });

  it('lets several wilds complete a line, and counts them', () => {
    const { win } = lineWin('B W B W B');
    expect(win?.pays).toBe(40);
    expect(win?.wilds).toBe(2);
  });

  it('extends leading wilds with the symbol they complete', () => {
    const { win } = lineWin('W W B B C');
    expect(win?.symbol).toBe('B');
    expect(win?.count).toBe(4);
    expect(win?.pays).toBe(15);
  });

  it('pays leading wilds on their own when that is worth more', () => {
    // As A: 4 symbols = 10. As wilds: 3 wilds = 100.
    const { win } = lineWin('W W W A C');
    expect(win?.symbol).toBe('W');
    expect(win?.count).toBe(3);
    expect(win?.pays).toBe(100);
  });

  it('pays a line made only of wilds', () => {
    const { win } = lineWin('W W W W W');
    expect(win?.pays).toBe(1000);
    expect(win?.wilds).toBe(5);
  });

  it('counts only the wilds inside the win', () => {
    // Wild on reel 4 is past the break at reel 3, so it is not part of the win.
    expect(lineWin('A W A C W').win?.wilds).toBe(1);
  });

  it('does not let a scatter take part in a line', () => {
    expect(lineWin('A S A A A').result.lineWins).toEqual([]);
    expect(lineWin('S A A A C').result.lineWins).toEqual([]);
  });

  it('follows the shape of the payline', () => {
    const result = evaluate(config, screenOf('A C C C A', 'C A C A C', 'C C A C C'));
    expect(result.lineWins).toEqual([
      {
        payline: 3,
        symbol: 'A',
        count: 5,
        pays: 50,
        wilds: 0,
        positions: [
          [0, 0],
          [1, 1],
          [2, 2],
          [3, 1],
          [4, 0],
        ],
      },
    ]);
  });

  it('adds up wins from several paylines', () => {
    const result = evaluate(config, screenOf('B B B C C', 'A A A C C', FILLER));
    expect(result.lineWins.map((w) => w.payline)).toEqual([0, 1]);
    expect(result.winLineBets).toBe(10 + 5);
  });
});

describe('scatter wins', () => {
  it('pays scatters anywhere on the screen, as a multiple of the total bet', () => {
    const result = evaluate(config, screenOf('S C C C C', 'C C S C C', 'C C C C S'));
    expect(result.lineWins).toEqual([]);
    expect(result.scatterWins).toEqual([
      {
        symbol: 'S',
        count: 3,
        pays: 2,
        positions: [
          [0, 0],
          [2, 1],
          [4, 2],
        ],
      },
    ]);
    // 2x the total bet = 2 x 4 line bets.
    expect(result.winLineBets).toBe(8);
    expect(result.multiplier).toBe(2);
  });

  it('pays nothing for too few scatters', () => {
    expect(evaluate(config, screenOf('S C C C C', 'C C S C C', FILLER)).scatterWins).toEqual([]);
  });

  it('adds scatter and line wins together', () => {
    const result = evaluate(config, screenOf('S C C C C', 'A A A S C', 'C C C C S'));
    expect(result.winLineBets).toBe(10 + 8);
  });
});

describe('playRound', () => {
  it('pays in whole cents: line bet x win in line bets', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i++) {
      const round = playRound(config, rng, 400);
      expect(round.winCents).toBe(round.evaluation.winLineBets * 100);
      expect(Number.isInteger(round.winCents)).toBe(true);
    }
  });

  it('is reproducible from its stops', () => {
    const round = playRound(config, createRng(123), 400);
    expect(round.screen).toEqual(screenFromStops(config, round.stops));
    expect(round.evaluation).toEqual(evaluate(config, round.screen));
  });

  it('rejects bets that cannot be split across the paylines', () => {
    expect(() => playRound(config, createRng(1), 10)).toThrow(RangeError);
  });

  it('rejects zero, negative and fractional bets', () => {
    expect(() => playRound(config, createRng(1), 0)).toThrow(RangeError);
    expect(() => playRound(config, createRng(1), -400)).toThrow(RangeError);
    expect(() => playRound(config, createRng(1), 400.5)).toThrow(RangeError);
  });
});
