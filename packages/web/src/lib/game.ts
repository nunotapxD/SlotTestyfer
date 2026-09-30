/** Game-screen maths that does not need the DOM: bets, balance and payline drawing. */

/** [reel, row] */
export type Position = readonly [number, number];

/** Bets the player can pick: a whole number of cents per line, times the number of lines. */
export function betOptions(lines: number, perLineCents = [1, 2, 5, 10, 20, 50, 100]): number[] {
  return perLineCents.map((cents) => cents * lines);
}

export const STARTING_BALANCE = 10_000;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Grid {
  /** Size of one cell, and the gap between cells, in pixels. */
  readonly cell: number;
  readonly gap: number;
}

/** Centre of a cell in the reel window. */
export function cellCentre([reel, row]: Position, grid: Grid): Point {
  const step = grid.cell + grid.gap;
  return { x: reel * step + grid.cell / 2, y: row * step + grid.cell / 2 };
}

/**
 * Points for drawing a winning payline: through the winning cells, then extended half a cell past
 * the first and last so the line reads as crossing the reels rather than stopping in a tile.
 */
export function linePoints(positions: readonly Position[], grid: Grid): Point[] {
  const centres = positions.map((p) => cellCentre(p, grid));
  const first = centres[0];
  const last = centres[centres.length - 1];
  if (!first || !last) return [];
  const reach = grid.cell / 2 + grid.gap / 2;
  return [{ x: first.x - reach, y: first.y }, ...centres, { x: last.x + reach, y: last.y }];
}

/** "reel:row" keys of every cell that is part of a win. */
export function winningCells(wins: readonly { positions: readonly Position[] }[]): Set<string> {
  const cells = new Set<string>();
  for (const win of wins) for (const [reel, row] of win.positions) cells.add(`${reel}:${row}`);
  return cells;
}

/** Symbols scrolling past before a reel stops: random stops of that reel's strip. */
export function spinningSymbols(strip: readonly string[], count: number, random = Math.random) {
  return Array.from({ length: count }, () => strip[Math.floor(random() * strip.length)] ?? '');
}
