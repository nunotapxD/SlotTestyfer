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
  const reels = config.reels;
  if (stops.length !== reels.length) {
    throw new RangeError(`expected ${reels.length} stops, got ${stops.length}`);
  }
  // Plain loops: this runs once per simulated round, so it avoids closures and callbacks.
  const screen: string[][] = new Array<string[]>(reels.length);
  for (let reel = 0; reel < reels.length; reel++) {
    const strip = reels[reel] ?? [];
    const stop = stops[reel] ?? -1;
    if (!Number.isInteger(stop) || stop < 0 || stop >= strip.length) {
      throw new RangeError(`stop ${stop} is outside reel ${reel} (0 to ${strip.length - 1})`);
    }
    const column: string[] = new Array<string>(config.rows);
    for (let row = 0; row < config.rows; row++) {
      column[row] = strip[(stop + row) % strip.length] ?? '';
    }
    screen[reel] = column;
  }
  return screen;
}

/**
 * Spins every reel once. Each stop is drawn uniformly from its strip, so how often a symbol
 * appears is controlled only by how many times it is placed on the strip.
 */
export function spin(config: GameConfig, rng: Rng): SpinResult {
  const reels = config.reels;
  const stops: number[] = new Array<number>(reels.length);
  for (let reel = 0; reel < reels.length; reel++) {
    stops[reel] = rng.nextInt(reels[reel]?.length ?? 1);
  }
  return { stops, screen: screenFromStops(config, stops) };
}
