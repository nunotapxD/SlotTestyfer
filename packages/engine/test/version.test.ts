import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, formatCredits } from '../src/index.js';

describe('engine', () => {
  it('exposes a semver version', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('formatCredits', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [12345, '123.45'],
    [-250, '-2.50'],
  ])('formats %i cents as %s', (cents, expected) => {
    expect(formatCredits(cents)).toBe(expected);
  });

  it('rejects fractional cents', () => {
    expect(() => formatCredits(1.5)).toThrow(RangeError);
  });
});
