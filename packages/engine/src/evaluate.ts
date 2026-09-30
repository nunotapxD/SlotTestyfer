/**
 * Prize evaluation: which paylines and scatters pay on a given screen, and how much.
 *
 * Rules (the usual ones for video slots):
 * - Line wins count matching symbols on a payline from the leftmost reel, with no gaps.
 * - A wild substitutes any regular symbol. A line that starts with wilds is paid as whichever
 *   is worth more: the wilds on their own or the wilds plus the symbol they complete.
 * - Scatters never pay on lines. They pay by how many appear anywhere on the screen.
 * - If a symbol has pays for 3 and 5 but not 4, four of them pay the 3-symbol prize.
 */
import type { GameConfig } from './config.js';
import type { Screen } from './spin.js';

/** [reel, row] of a symbol that is part of a win. */
export type Position = readonly [reel: number, row: number];

export interface LineWin {
  /** Index of the payline in the config. */
  readonly payline: number;
  readonly symbol: string;
  readonly count: number;
  /** Multiplier of the line bet. */
  readonly pays: number;
  /** How many of the winning symbols are wilds (all of them for a line of wilds). */
  readonly wilds: number;
  readonly positions: readonly Position[];
}

export interface ScatterWin {
  readonly symbol: string;
  readonly count: number;
  /** Multiplier of the total bet. */
  readonly pays: number;
  readonly positions: readonly Position[];
}

export interface Evaluation {
  readonly lineWins: readonly LineWin[];
  readonly scatterWins: readonly ScatterWin[];
  /**
   * Total win in line bets. Always a whole number, so the payout in cents is exact:
   * `winLineBets * lineBetCents`.
   */
  readonly winLineBets: number;
  /** Total win as a multiple of the total bet (winLineBets / number of paylines). */
  readonly multiplier: number;
}

export type Evaluator = (screen: Screen) => Evaluation;

type Kind = 'regular' | 'wild' | 'scatter';

/**
 * Prepares the lookups for a game once, so evaluating millions of screens stays fast.
 * Returns a function that evaluates one screen.
 */
export function createEvaluator(config: GameConfig): Evaluator {
  const kinds = new Map<string, Kind>(config.symbols.map((s) => [s.id, s.kind]));
  const lines = config.paylines.length;
  const maxCount = config.reels.length * config.rows;

  // bestPay.get(symbol)[n] = prize for n symbols (the best defined prize for n or fewer).
  const bestPay = new Map<string, number[]>();
  for (const symbol of config.symbols) {
    const table = new Array<number>(maxCount + 1).fill(0);
    for (const pay of config.paytable) {
      if (pay.symbol === symbol.id) table[pay.count] = pay.pays;
    }
    for (let n = 1; n <= maxCount; n++) {
      table[n] = Math.max(table[n] ?? 0, table[n - 1] ?? 0);
    }
    bestPay.set(symbol.id, table);
  }
  const payFor = (symbol: string, count: number): number => bestPay.get(symbol)?.[count] ?? 0;
  const kindOf = (symbol: string): Kind => kinds.get(symbol) ?? 'regular';
  const scatters = config.symbols.filter((s) => s.kind === 'scatter').map((s) => s.id);
  const paylines = config.paylines;
  const reelCount = config.reels.length;
  // Reused for every payline: the symbols along the line. Avoids one allocation per line.
  const symbols = new Array<string>(reelCount).fill('');

  // Plain loops below: this runs once per simulated round.
  return (screen) => {
    const lineWins: LineWin[] = [];
    let winLineBets = 0;

    for (let index = 0; index < paylines.length; index++) {
      const payline = paylines[index] ?? [];
      for (let reel = 0; reel < reelCount; reel++) {
        symbols[reel] = screen[reel]?.[payline[reel] ?? 0] ?? '';
      }
      const first = symbols[0] ?? '';
      if (kindOf(first) === 'scatter') continue;

      // Leading wilds, then the first regular symbol and how far it (plus wilds) reaches.
      let wildRun = 0;
      while (wildRun < reelCount && kindOf(symbols[wildRun] ?? '') === 'wild') wildRun++;

      let base: string | undefined;
      let baseCount = wildRun;
      for (let reel = wildRun; reel < reelCount; reel++) {
        const symbol = symbols[reel] ?? '';
        const kind = kindOf(symbol);
        if (kind === 'scatter') break;
        if (kind === 'wild') {
          baseCount++;
          continue;
        }
        if (base === undefined) base = symbol;
        else if (symbol !== base) break;
        baseCount++;
      }

      const basePays = base === undefined ? 0 : payFor(base, baseCount);
      const wildPays = wildRun > 0 ? payFor(first, wildRun) : 0;
      if (basePays === 0 && wildPays === 0) continue;

      const useBase = basePays >= wildPays && base !== undefined;
      const symbol = useBase ? (base ?? first) : first;
      const count = useBase ? baseCount : wildRun;
      const pays = useBase ? basePays : wildPays;
      const positions: Position[] = [];
      let wilds = 0;
      for (let reel = 0; reel < count; reel++) {
        positions.push([reel, payline[reel] ?? 0]);
        if (kindOf(symbols[reel] ?? '') === 'wild') wilds++;
      }

      lineWins.push({ payline: index, symbol, count, pays, wilds, positions });
      winLineBets += pays;
    }

    const scatterWins: ScatterWin[] = [];
    for (const scatter of scatters) {
      let count = 0;
      for (const column of screen) {
        for (const symbol of column) if (symbol === scatter) count++;
      }
      const pays = payFor(scatter, count);
      if (pays > 0) {
        const positions: Position[] = [];
        screen.forEach((column, reel) => {
          column.forEach((symbol, row) => {
            if (symbol === scatter) positions.push([reel, row]);
          });
        });
        scatterWins.push({ symbol: scatter, count, pays, positions });
        winLineBets += pays * lines;
      }
    }

    return { lineWins, scatterWins, winLineBets, multiplier: winLineBets / lines };
  };
}

/** Evaluates a single screen. For many screens, create the evaluator once and reuse it. */
export function evaluate(config: GameConfig, screen: Screen): Evaluation {
  return createEvaluator(config)(screen);
}
