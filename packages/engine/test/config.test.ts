import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GameConfigError, parseGameConfig } from '../src/index.js';

function loadGame(file: string): unknown {
  const url = new URL(`../../../games/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** A small valid 3x3 game that each test changes in one place. */
function validConfig() {
  return {
    id: 'tiny',
    name: 'Tiny',
    rows: 3,
    symbols: [
      { id: 'A', kind: 'regular' },
      { id: 'B', kind: 'regular' },
      { id: 'W', kind: 'wild' },
      { id: 'S', kind: 'scatter' },
    ],
    reels: [
      ['A', 'B', 'W', 'S'],
      ['B', 'A', 'W', 'S'],
      ['A', 'W', 'B', 'S'],
    ],
    paylines: [
      [1, 1, 1],
      [0, 1, 2],
    ],
    paytable: [
      { symbol: 'A', count: 3, pays: 5 },
      { symbol: 'S', count: 3, pays: 2 },
    ],
  };
}

function issuesOf(input: unknown): readonly string[] {
  try {
    parseGameConfig(input);
  } catch (error) {
    if (error instanceof GameConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected the config to be rejected');
}

describe('parseGameConfig', () => {
  it('accepts the bundled demo game', () => {
    const game = parseGameConfig(loadGame('fruits-demo.json'));
    expect(game.id).toBe('fruits-demo');
    expect(game.reels).toHaveLength(3);
    expect(game.paylines).toHaveLength(5);
  });

  it('accepts a minimal valid config', () => {
    expect(parseGameConfig(validConfig()).name).toBe('Tiny');
  });

  it('rejects input that is not an object', () => {
    expect(() => parseGameConfig('nope')).toThrow(GameConfigError);
  });

  it('rejects an unknown symbol kind', () => {
    const config = validConfig();
    config.symbols[0] = { id: 'A', kind: 'bonus' };
    expect(issuesOf(config).join()).toMatch(/symbols\.0\.kind/);
  });

  it('rejects duplicate symbol ids', () => {
    const config = validConfig();
    config.symbols.push({ id: 'A', kind: 'regular' });
    expect(issuesOf(config)).toContain('symbols.4.id: duplicate symbol A');
  });

  it('rejects reels that use undeclared symbols', () => {
    const config = validConfig();
    config.reels[1] = ['B', 'A', 'X', 'S'];
    expect(issuesOf(config)).toContain('reels.1.2: unknown symbol X');
  });

  it('rejects reels shorter than the visible rows', () => {
    const config = validConfig();
    config.reels[0] = ['A', 'B'];
    expect(issuesOf(config)).toContain('reels.0: reel 0 has 2 stops but the screen shows 3 rows');
  });

  it('rejects paylines with the wrong length', () => {
    const config = validConfig();
    config.paylines.push([1, 1]);
    expect(issuesOf(config)).toContain(
      'paylines.2: payline 2 has 2 positions but the game has 3 reels',
    );
  });

  it('rejects paylines that point outside the screen', () => {
    const config = validConfig();
    config.paylines.push([1, 3, 1]);
    expect(issuesOf(config)).toContain(
      'paylines.2.1: row 3 does not exist, the screen has rows 0 to 2',
    );
  });

  it('rejects pays for more symbols than there are reels', () => {
    const config = validConfig();
    config.paytable.push({ symbol: 'B', count: 4, pays: 10 });
    expect(issuesOf(config)).toContain('paytable.2.count: B can appear at most 3 times, got 4');
  });

  it('allows scatter pays up to the number of screen positions', () => {
    const config = validConfig();
    config.paytable.push({ symbol: 'S', count: 5, pays: 50 });
    expect(() => parseGameConfig(config)).not.toThrow();
  });

  it('rejects duplicate pays and non-positive multipliers', () => {
    const config = validConfig();
    config.paytable.push({ symbol: 'A', count: 3, pays: 0 });
    const issues = issuesOf(config);
    expect(issues).toContain('paytable.2: duplicate pay for 3 x A');
    expect(issues.join()).toMatch(/paytable\.2\.pays/);
  });

  it('reports every problem at once', () => {
    const config = validConfig();
    config.reels[0] = ['A', 'X', 'Y'];
    config.paylines.push([9, 9, 9]);
    expect(issuesOf(config).length).toBeGreaterThanOrEqual(5);
  });
});
