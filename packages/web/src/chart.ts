/** A small SVG line chart: several series, optional confidence bands and reference bands. */
import { s } from './dom.js';
import { bandPath, linePath, linearScale, logScale, logTicks, niceTicks } from './lib/charts.js';

export interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly points: readonly { x: number; y: number }[];
  /** Shaded band around the line, e.g. a confidence interval. */
  readonly band?: readonly { x: number; low: number; high: number }[];
  readonly width?: number;
  readonly opacity?: number;
}

export interface LineChartOptions {
  readonly width: number;
  readonly height: number;
  readonly series: readonly ChartSeries[];
  readonly xLog?: boolean;
  readonly xDomain?: readonly [number, number];
  readonly yDomain?: readonly [number, number];
  /** Horizontal reference bands, e.g. target ± tolerance. */
  readonly bands?: readonly { y0: number; y1: number; label?: string }[];
  /** Horizontal reference lines. */
  readonly rules?: readonly { y: number; label?: string }[];
  readonly xFormat: (v: number) => string;
  readonly yFormat: (v: number) => string;
  readonly ariaLabel: string;
}

const M = { top: 10, right: 12, bottom: 24, left: 56 };

export function lineChart(o: LineChartOptions): SVGSVGElement {
  const w = Math.max(200, o.width);
  const h = o.height;
  const plotW = w - M.left - M.right;
  const plotH = h - M.top - M.bottom;

  const xs = o.series.flatMap((serie) => serie.points.map((p) => p.x));
  const ys = o.series.flatMap((serie) => [
    ...serie.points.map((p) => p.y),
    ...(serie.band ?? []).flatMap((b) => [b.low, b.high]),
  ]);
  for (const band of o.bands ?? []) ys.push(band.y0, band.y1);
  for (const rule of o.rules ?? []) ys.push(rule.y);

  const xDomain = o.xDomain ?? [
    o.xLog ? Math.max(1, Math.min(...xs)) : Math.min(0, ...xs),
    Math.max(...xs, 1),
  ];
  let yDomain = o.yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (!(yDomain[1] > yDomain[0])) yDomain = [yDomain[0] - 1, yDomain[0] + 1];
  const pad = (yDomain[1] - yDomain[0]) * 0.06;
  const [y0, y1] = o.yDomain ?? [yDomain[0] - pad, yDomain[1] + pad];

  const x = (o.xLog ? logScale : linearScale)(xDomain, [M.left, M.left + plotW]);
  const y = linearScale([y0, y1], [M.top + plotH, M.top]);
  const clip = `clip-${Math.random().toString(36).slice(2)}`;

  const xTicks = o.xLog ? logTicks(xDomain[0], xDomain[1]) : niceTicks(xDomain[0], xDomain[1], 5);
  const yTicks = niceTicks(y0, y1, 4);

  return s(
    'svg',
    {
      class: 'line-chart',
      viewBox: `0 0 ${w} ${h}`,
      role: 'img',
      'aria-label': o.ariaLabel,
    },
    s(
      'defs',
      {},
      s('clipPath', { id: clip }, s('rect', { x: M.left, y: M.top, width: plotW, height: plotH })),
    ),
    ...yTicks.map((t) =>
      s(
        'g',
        {},
        s('line', { class: 'grid', x1: M.left, x2: M.left + plotW, y1: y(t), y2: y(t) }),
        s(
          'text',
          { class: 'tick', x: M.left - 6, y: y(t) + 4, 'text-anchor': 'end' },
          o.yFormat(t),
        ),
      ),
    ),
    ...xTicks.map((t) =>
      s('text', { class: 'tick', x: x(t), y: h - 6, 'text-anchor': 'middle' }, o.xFormat(t)),
    ),
    s(
      'g',
      { 'clip-path': `url(#${clip})` },
      ...(o.bands ?? []).map((b) =>
        s('rect', {
          class: 'ref-band',
          x: M.left,
          width: plotW,
          y: y(Math.max(b.y0, b.y1)),
          height: Math.abs(y(b.y0) - y(b.y1)),
        }),
      ),
      ...(o.rules ?? []).map((r) =>
        s('line', { class: 'ref-rule', x1: M.left, x2: M.left + plotW, y1: y(r.y), y2: y(r.y) }),
      ),
      ...o.series.flatMap((serie) => [
        serie.band && serie.band.length > 1
          ? s('path', {
              class: 'ci-band',
              fill: serie.color,
              d: bandPath(
                serie.band.map((b) => ({ x: x(b.x), y: y(b.high) })),
                serie.band.map((b) => ({ x: x(b.x), y: y(b.low) })),
              ),
            })
          : null,
        s('path', {
          class: 'series',
          stroke: serie.color,
          'stroke-width': serie.width ?? 2,
          opacity: serie.opacity ?? 1,
          d: linePath(serie.points.map((p) => ({ x: x(p.x), y: y(p.y) }))),
        }),
      ]),
    ),
  );
}
