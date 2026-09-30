import { describe, expect, it } from 'vitest';
import { niceCeil, scale, verticalBars } from '../src/lib/charts.js';
import { parseOptionalInt, parseOptionalPercent } from '../src/lib/form.js';
import {
  formatCompact,
  formatCredits,
  formatDuration,
  formatInt,
  formatMultiplier,
  formatPercent,
} from '../src/lib/format.js';
import {
  betOptions,
  cellCentre,
  linePoints,
  spinningSymbols,
  winningCells,
} from '../src/lib/game.js';
import { hueOf, symbolLook } from '../src/lib/symbols.js';

describe('format', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [12345, '123.45'],
    [123456789, '1,234,567.89'],
    [-250, '-2.50'],
  ])('formats %i cents as %s', (cents, text) => {
    expect(formatCredits(cents)).toBe(text);
  });

  it('formats percentages, counts and multipliers', () => {
    expect(formatPercent(0.959375)).toBe('95.94%');
    expect(formatPercent(0.959375, 3)).toBe('95.938%');
    expect(formatInt(10_000_000)).toBe('10,000,000');
    expect(formatMultiplier(44)).toBe('44x');
    expect(formatMultiplier(2.5)).toBe('2.5x');
  });

  it('writes large numbers compactly', () => {
    expect([999, 1000, 250_000, 1_000_000, 2_500_000, 10_000_000].map(formatCompact)).toEqual([
      '999',
      '1k',
      '250k',
      '1M',
      '2.5M',
      '10M',
    ]);
  });

  it('writes durations', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(65_000)).toBe('1 min 5 s');
  });
});

describe('form parsing', () => {
  it('reads optional whole numbers', () => {
    expect(parseOptionalInt('', 0, 10)).toBeUndefined();
    expect(parseOptionalInt(' 42 ', 0, 100)).toBe(42);
    expect(parseOptionalInt('10,000,000', 1, 1e8)).toBe(10_000_000);
    expect(() => parseOptionalInt('4.5', 0, 10)).toThrow(RangeError);
    expect(() => parseOptionalInt('11', 0, 10)).toThrow(RangeError);
  });

  it('reads optional percentages as fractions', () => {
    expect(parseOptionalPercent('')).toBeUndefined();
    expect(parseOptionalPercent('96')).toBe(0.96);
    expect(parseOptionalPercent('0.5%')).toBe(0.005);
    expect(() => parseOptionalPercent('abc')).toThrow(RangeError);
    expect(() => parseOptionalPercent('-1')).toThrow(RangeError);
  });
});

describe('game helpers', () => {
  it('offers bets that split evenly across the lines', () => {
    const bets = betOptions(5);
    expect(bets[0]).toBe(5);
    expect(bets.every((bet) => bet % 5 === 0)).toBe(true);
  });

  it('finds cell centres and draws lines across the reels', () => {
    const grid = { cell: 100, gap: 10 };
    expect(cellCentre([0, 0], grid)).toEqual({ x: 50, y: 50 });
    expect(cellCentre([2, 1], grid)).toEqual({ x: 270, y: 160 });
    expect(
      linePoints(
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        grid,
      ),
    ).toEqual([
      { x: -5, y: 50 },
      { x: 50, y: 50 },
      { x: 160, y: 160 },
      { x: 270, y: 270 },
      { x: 325, y: 270 },
    ]);
    expect(linePoints([], grid)).toEqual([]);
  });

  it('collects the winning cells of every win', () => {
    const cells = winningCells([
      {
        positions: [
          [0, 1],
          [1, 1],
        ],
      },
      { positions: [[1, 1]] },
    ]);
    expect([...cells].sort()).toEqual(['0:1', '1:1']);
  });

  it('picks spinning symbols from the reel strip', () => {
    const values = [0, 0.5, 0.99];
    let i = 0;
    const random = () => values[i++ % values.length] ?? 0;
    expect(spinningSymbols(['A', 'B', 'C', 'D'], 3, random)).toEqual(['A', 'C', 'D']);
  });
});

describe('charts', () => {
  it('rounds scales up to tidy numbers', () => {
    expect([0.47, 0.083, 3, 7, 12, 0].map(niceCeil)).toEqual([0.5, 0.1, 5, 10, 20, 1]);
  });

  it('lays out vertical bars', () => {
    const chart = verticalBars(
      [
        { label: 'a', value: 0.5 },
        { label: 'b', value: 0.25 },
      ],
      208,
      100,
      8,
    );
    expect(chart.max).toBe(0.5);
    expect(chart.bars.map((b) => [b.x, b.width, b.height, b.y])).toEqual([
      [0, 100, 100, 0],
      [108, 100, 50, 50],
    ]);
  });

  it('places values on a scale', () => {
    expect(scale(5, 0, 10)).toBe(0.5);
    expect(scale(-1, 0, 10)).toBe(0);
    expect(scale(11, 0, 10)).toBe(1);
  });
});

describe('symbols', () => {
  it('gives known symbols a glyph and a label', () => {
    expect(symbolLook('CHERRY')).toMatchObject({ glyph: '🍒', label: 'Cherry', isText: false });
    expect(symbolLook('SEVEN')).toMatchObject({ glyph: '7', isText: true });
  });

  it('gives unknown symbols initials and a stable colour', () => {
    expect(symbolLook('GOLD_COIN')).toMatchObject({
      glyph: 'GC',
      label: 'Gold coin',
      isText: true,
    });
    expect(hueOf('GOLD_COIN')).toBe(hueOf('GOLD_COIN'));
    expect(hueOf('GOLD_COIN')).toBeGreaterThanOrEqual(0);
    expect(hueOf('GOLD_COIN')).toBeLessThan(360);
  });
});
