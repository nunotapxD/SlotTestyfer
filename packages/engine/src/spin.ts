/**
 * Spinning the reels: turning random numbers into the grid of symbols the player sees.
 */
import type { GameConfig } from './config.js';
import type { Rng } from './rng.js';

/**
 * The visible symbols, one column per reel: `screen[reel][row]`, row 0 at the top.
 * Paylines index it the same way: payline `[0, 1, 2]` reads screen[0][0], screen[1][1], screen[2][2].
 */
export type Screen = readonly (readonly string[])[];

export interface SpinResult {
  /** Index on each reel strip of the symbol shown in the top row. Enough to replay the spin. */
  readonly stops: readonly number[];
  readonly screen: Screen;
}

/**
 * Builds the screen for a given set of stops. Each reel shows `rows` consecutive symbols
 * starting at its stop, wrapping around the end of the strip like a physical reel.
 */
export function screenFromStops(config: GameConfig, stops: readonly number[]): Screen {
  if (stops.length !== config.reels.length) {
    throw new RangeError(`expected ${config.reels.length} stops, got ${stops.length}`);
  }
  return config.reels.map((strip, reel) => {
    const stop = stops[reel] ?? -1;
    if (!Number.isInteger(stop) || stop < 0 || stop >= strip.length) {
      throw new RangeError(`stop ${stop} is outside reel ${reel} (0 to ${strip.length - 1})`);
    }
    return Array.from({ length: config.rows }, (_, row) => {
      const symbol = strip[(stop + row) % strip.length];
      if (symbol === undefined) {
        throw new Error(`reel ${reel} has no symbol at ${(stop + row) % strip.length}`);
      }
      return symbol;
    });
  });
}

/**
 * Spins every reel once. Each stop is drawn uniformly from its strip, so how often a symbol
 * appears is controlled only by how many times it is placed on the strip.
 */
export function spin(config: GameConfig, rng: Rng): SpinResult {
  const stops = config.reels.map((strip) => rng.nextInt(strip.length));
  return { stops, screen: screenFromStops(config, stops) };
}
