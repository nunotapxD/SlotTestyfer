/**
 * Game configuration: symbols, reel strips, paylines and paytable.
 *
 * A game is pure data (JSON). The engine never trusts it blindly: {@link parseGameConfig}
 * checks the shape with Zod and then the rules that connect the fields, such as every reel
 * symbol being declared and every payline fitting inside the grid.
 */
import { z } from 'zod';

const SYMBOL_ID = /^[A-Z][A-Z0-9_]*$/;

export const SymbolSchema = z.object({
  id: z.string().regex(SYMBOL_ID, 'symbol ids are UPPER_SNAKE_CASE, e.g. CHERRY or BAR_2'),
  /** regular: pays on paylines. wild: substitutes regular symbols. scatter: pays anywhere. */
  kind: z.enum(['regular', 'wild', 'scatter']),
});

export const PaySchema = z.object({
  symbol: z.string(),
  /** How many matching symbols are needed (from the leftmost reel, or anywhere for scatters). */
  count: z.number().int().min(1),
  /** Multiplier. Line pays multiply the line bet; scatter pays multiply the total bet. */
  pays: z.number().positive(),
});

export const GameConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'game ids are kebab-case, e.g. fruits-96'),
    name: z.string().min(1),
    /** Number of visible rows on screen. */
    rows: z.number().int().min(1).max(10),
    symbols: z.array(SymbolSchema).min(2),
    /** One reel strip per reel, read top to bottom. The screen shows `rows` consecutive stops. */
    reels: z.array(z.array(z.string()).min(1)).min(1).max(10),
    /** Each payline lists the row index used on each reel, e.g. [1, 1, 1] is the middle row. */
    paylines: z.array(z.array(z.number().int().min(0))).min(1),
    paytable: z.array(PaySchema).min(1),
  })
  .superRefine((config, ctx) => {
    const kinds = new Map<string, string>();
    config.symbols.forEach((symbol, i) => {
      if (kinds.has(symbol.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['symbols', i, 'id'],
          message: `duplicate symbol ${symbol.id}`,
        });
      }
      kinds.set(symbol.id, symbol.kind);
    });

    const reelCount = config.reels.length;

    config.reels.forEach((strip, r) => {
      if (strip.length < config.rows) {
        ctx.addIssue({
          code: 'custom',
          path: ['reels', r],
          message: `reel ${r} has ${strip.length} stops but the screen shows ${config.rows} rows`,
        });
      }
      strip.forEach((id, s) => {
        if (!kinds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['reels', r, s],
            message: `unknown symbol ${id}`,
          });
        }
      });
    });

    config.paylines.forEach((line, l) => {
      if (line.length !== reelCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['paylines', l],
          message: `payline ${l} has ${line.length} positions but the game has ${reelCount} reels`,
        });
      }
      line.forEach((row, r) => {
        if (row >= config.rows) {
          ctx.addIssue({
            code: 'custom',
            path: ['paylines', l, r],
            message: `row ${row} does not exist, the screen has rows 0 to ${config.rows - 1}`,
          });
        }
      });
    });

    const seenPays = new Set<string>();
    config.paytable.forEach((pay, p) => {
      if (!kinds.has(pay.symbol)) {
        ctx.addIssue({
          code: 'custom',
          path: ['paytable', p, 'symbol'],
          message: `unknown symbol ${pay.symbol}`,
        });
      }
      const maxCount = kinds.get(pay.symbol) === 'scatter' ? reelCount * config.rows : reelCount;
      if (pay.count > maxCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['paytable', p, 'count'],
          message: `${pay.symbol} can appear at most ${maxCount} times, got ${pay.count}`,
        });
      }
      const key = `${pay.symbol}x${pay.count}`;
      if (seenPays.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['paytable', p],
          message: `duplicate pay for ${pay.count} x ${pay.symbol}`,
        });
      }
      seenPays.add(key);
    });
  });

export type GameSymbol = z.infer<typeof SymbolSchema>;
export type Pay = z.infer<typeof PaySchema>;
export type GameConfig = z.infer<typeof GameConfigSchema>;

/** Thrown when a game configuration is invalid. `issues` lists every problem found. */
export class GameConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid game config:\n- ${issues.join('\n- ')}`);
    this.name = 'GameConfigError';
    this.issues = issues;
  }
}

/** Validates unknown input (usually parsed JSON) and returns a typed game config. */
export function parseGameConfig(input: unknown): GameConfig {
  const result = GameConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const where = issue.path.map(String).join('.');
      return where ? `${where}: ${issue.message}` : issue.message;
    });
    throw new GameConfigError(issues);
  }
  return result.data;
}
