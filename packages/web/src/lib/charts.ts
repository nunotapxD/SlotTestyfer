/** Chart geometry for the simulation report, kept out of the DOM code so it can be tested. */

export interface Bar {
  readonly label: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BarChart {
  readonly bars: Bar[];
  /** Value at the top of the scale (the largest value, rounded up to a tidy number). */
  readonly max: number;
}

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten: 0.47 -> 0.5, 0.083 -> 0.1. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value - 1e-12) ?? 10;
  return step * power;
}

/** Vertical bars filling width x height, with a gap between them. */
export function verticalBars(
  data: readonly { label: string; value: number }[],
  width: number,
  height: number,
  gap = 8,
): BarChart {
  const max = niceCeil(Math.max(0, ...data.map((d) => d.value)));
  const n = Math.max(1, data.length);
  const barWidth = (width - gap * (n - 1)) / n;
  const bars = data.map((d, i) => {
    const barHeight = max > 0 ? (d.value / max) * height : 0;
    return {
      label: d.label,
      value: d.value,
      x: i * (barWidth + gap),
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
  return { bars, max };
}

/** Where a value sits on a horizontal scale from min to max, as a fraction 0-1 (clamped). */
export function scale(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

// ---------- line charts ----------

export type ScaleFn = (value: number) => number;

/** Maps [d0, d1] onto [r0, r1] linearly. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): ScaleFn {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Maps [d0, d1] (both > 0) onto [r0, r1] on a base-10 log scale. */
export function logScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): ScaleFn {
  const [d0, d1] = domain.map((d) => Math.log10(Math.max(d, 1e-12))) as [number, number];
  const linear = linearScale([d0, d1], range);
  return (v) => linear(Math.log10(Math.max(v, 1e-12)));
}

/** About `count` round-numbered ticks between min and max (steps of 1, 2 or 5 x 10^n). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

/** Powers of ten between min and max, for a log axis. */
export function logTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  for (let p = Math.ceil(Math.log10(min)); 10 ** p <= max; p++) ticks.push(10 ** p);
  return ticks;
}

/** SVG path through the points. */
export function linePath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}

/** Closed SVG path for a band between an upper and a lower line (same x positions). */
export function bandPath(
  upper: readonly { x: number; y: number }[],
  lower: readonly { x: number; y: number }[],
): string {
  if (upper.length === 0) return '';
  return `${linePath(upper)}L${[...lower]
    .reverse()
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join('L')}Z`;
}
