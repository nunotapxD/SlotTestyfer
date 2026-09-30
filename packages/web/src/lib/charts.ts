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
