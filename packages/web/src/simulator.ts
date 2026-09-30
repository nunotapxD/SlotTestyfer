/**
 * The simulator panel: start a Monte Carlo run through the API, follow its progress, and show
 * the report: RTP with its confidence interval, the verdict, the win distribution and where the
 * RTP comes from.
 */
import {
  api,
  ApiRequestError,
  type GameSummary,
  type Report,
  type Simulation,
  type Verdict,
} from './api.js';
import { h, s, wait } from './dom.js';
import { symbolCell } from './game.js';
import { scale, verticalBars } from './lib/charts.js';
import { parseOptionalInt, parseOptionalPercent } from './lib/form.js';
import {
  formatCompact,
  formatDuration,
  formatInt,
  formatMultiplier,
  formatPercent,
} from './lib/format.js';
import { symbolLook } from './lib/symbols.js';

const ROUND_CHOICES = [100_000, 1_000_000, 10_000_000, 50_000_000];
const POLL_MS = 400;

function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

function elapsedMs(sim: Simulation, now = Date.now()): number | null {
  if (!sim.startedAt) return null;
  const end = sim.finishedAt ? Date.parse(sim.finishedAt) : now;
  return Math.max(0, end - Date.parse(sim.startedAt));
}

// ---------- charts ----------

/**
 * The verdict, drawn: the allowed range (target ± tolerance) as a band, the 95% confidence
 * interval as a bar, and the estimate as a dot. PASS when the bar sits inside the band.
 */
function confidenceChart(report: Report, verdict: Verdict | null, width: number): SVGSVGElement {
  const height = 70;
  const low = report.interval.low;
  const high = report.interval.high;
  const bandLow = verdict ? verdict.target - verdict.tolerance : low;
  const bandHigh = verdict ? verdict.target + verdict.tolerance : high;
  const span = Math.max(high, bandHigh) - Math.min(low, bandLow) || 0.01;
  const min = Math.min(low, bandLow) - span * 0.15;
  const max = Math.max(high, bandHigh) + span * 0.15;
  const x = (v: number) => scale(v, min, max) * width;
  const colour = verdict
    ? { PASS: 'var(--pass)', FAIL: 'var(--fail)', INCONCLUSIVE: 'var(--warn)' }[verdict.status]
    : 'var(--accent)';
  const axisY = 30;

  const ticks = verdict ? [bandLow, verdict.target, bandHigh] : [low, report.rtp, high];

  return s(
    'svg',
    {
      class: 'ci-chart',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': verdict
        ? `Confidence interval ${formatPercent(low, 3)} to ${formatPercent(high, 3)} against the allowed range ${formatPercent(bandLow)} to ${formatPercent(bandHigh)}`
        : `Confidence interval ${formatPercent(low, 3)} to ${formatPercent(high, 3)}`,
    },
    s('line', { x1: 0, x2: width, y1: axisY, y2: axisY, stroke: 'var(--line)', 'stroke-width': 2 }),
    verdict
      ? s('rect', {
          x: x(bandLow),
          y: axisY - 18,
          width: Math.max(1, x(bandHigh) - x(bandLow)),
          height: 36,
          rx: 6,
          fill: 'var(--accent-soft)',
          stroke: 'var(--accent)',
          'stroke-dasharray': '4 4',
        })
      : null,
    verdict
      ? s('line', {
          x1: x(verdict.target),
          x2: x(verdict.target),
          y1: axisY - 18,
          y2: axisY + 18,
          stroke: 'var(--accent)',
          'stroke-width': 1.5,
        })
      : null,
    s('line', {
      x1: x(low),
      x2: x(high),
      y1: axisY,
      y2: axisY,
      stroke: colour,
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
    s('circle', {
      cx: x(report.rtp),
      cy: axisY,
      r: 7,
      fill: 'var(--surface)',
      stroke: colour,
      'stroke-width': 3,
    }),
    ...ticks.map((v) =>
      s('text', { x: x(v), y: height - 4, 'text-anchor': 'middle' }, formatPercent(v)),
    ),
  );
}

function histogramChart(report: Report): SVGSVGElement {
  const width = 360;
  const chartHeight = 130;
  const top = 18;
  const bottom = 22;
  const chart = verticalBars(
    report.histogram.map((b) => ({ label: b.label, value: b.share })),
    width,
    chartHeight,
    10,
  );
  return s(
    'svg',
    {
      class: 'histogram',
      viewBox: `0 0 ${width} ${chartHeight + top + bottom}`,
      role: 'img',
      'aria-label': `Win distribution: ${report.histogram.map((b) => `${b.label} ${formatPercent(b.share, 1)}`).join(', ')}`,
    },
    s('line', {
      class: 'grid-line',
      x1: 0,
      x2: width,
      y1: top + chartHeight,
      y2: top + chartHeight,
    }),
    ...chart.bars.flatMap((bar) => [
      s('rect', {
        class: bar.label === '0x' ? 'bar zero' : 'bar',
        x: bar.x,
        y: top + bar.y,
        width: bar.width,
        height: Math.max(bar.value > 0 ? 1.5 : 0, bar.height),
        rx: 3,
      }),
      s(
        'text',
        { class: 'value', x: bar.x + bar.width / 2, y: top + bar.y - 5, 'text-anchor': 'middle' },
        bar.value > 0 && bar.value < 0.001 ? '<0.1%' : formatPercent(bar.value, 1),
      ),
      s(
        'text',
        { x: bar.x + bar.width / 2, y: top + chartHeight + 16, 'text-anchor': 'middle' },
        bar.label,
      ),
    ]),
  );
}

/** Where the RTP comes from: base line wins, base scatters and free spins, as one stacked bar. */
function featureChart(report: Report): HTMLElement {
  const parts = [
    { label: 'Line wins', value: report.rtpByFeature.lines, color: 'var(--accent)' },
    { label: 'Scatters', value: report.rtpByFeature.scatters, color: 'var(--gold)' },
    { label: 'Free spins', value: report.rtpByFeature.freeSpins, color: 'var(--violet)' },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  return h(
    'div',
    { class: 'feature-chart' },
    h(
      'div',
      {
        class: 'stack',
        role: 'img',
        'aria-label': parts.map((p) => `${p.label} ${formatPercent(p.value)}`).join(', '),
      },
      ...parts.map((p) =>
        h('span', { style: `width: ${(p.value / total) * 100}%; background: ${p.color}` }),
      ),
    ),
    h(
      'ul',
      { class: 'legend' },
      ...parts.map((p) =>
        h(
          'li',
          {},
          h('i', { style: `background: ${p.color}` }),
          p.label,
          h('b', { class: 'num' }, formatPercent(p.value)),
        ),
      ),
      h(
        'li',
        { class: 'muted' },
        'Line wins that needed a wild',
        h('b', { class: 'num' }, formatPercent(report.rtpByFeature.wildAssisted)),
      ),
    ),
  );
}

function symbolChart(report: Report): HTMLElement {
  const max = Math.max(0, ...report.rtpBySymbol.map((r) => r.rtp));
  return h(
    'ul',
    { class: 'symbol-bars' },
    ...report.rtpBySymbol.map((r) =>
      h(
        'li',
        { title: `${symbolLook(r.symbol).label}: ${formatPercent(r.rtp, 3)} of the RTP` },
        symbolCell(r.symbol),
        h('span', { class: 'name' }, symbolLook(r.symbol).label),
        h(
          'div',
          { class: 'track' },
          h('div', { class: 'fill', style: `width: ${max > 0 ? (r.rtp / max) * 100 : 0}%` }),
        ),
        h('span', { class: 'num' }, formatPercent(r.rtp)),
      ),
    ),
  );
}

// ---------- panel ----------

export function mountSimulator(
  root: HTMLElement,
  games: readonly GameSummary[],
  showError: (message: string) => void,
): void {
  const gameName = new Map(games.map((g) => [g.id, g.name]));
  /** Incremented for each run, so an old poll loop stops when a new run starts. */
  let runToken = 0;

  const gameSelect = h(
    'select',
    { id: 'sim-game' },
    ...games.map((g) => h('option', { value: g.id }, g.name)),
  );
  const roundsSelect = h(
    'select',
    { id: 'sim-rounds' },
    ...ROUND_CHOICES.map((n) => h('option', { value: n }, formatCompact(n))),
  );
  roundsSelect.value = String(1_000_000);
  const seedInput = h('input', {
    id: 'sim-seed',
    type: 'text',
    inputmode: 'numeric',
    placeholder: 'random',
    autocomplete: 'off',
  });
  const targetInput = h('input', {
    id: 'sim-target',
    type: 'text',
    inputmode: 'decimal',
    value: '96',
    autocomplete: 'off',
  });
  const toleranceInput = h('input', {
    id: 'sim-tolerance',
    type: 'text',
    inputmode: 'decimal',
    value: '0.5',
    autocomplete: 'off',
  });
  const runButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Run simulation');
  const formError = h('span', { class: 'form-error', role: 'alert' });

  const form = h(
    'form',
    { class: 'sim-form', novalidate: true },
    h('label', { class: 'field' }, h('span', {}, 'Game'), gameSelect),
    h('label', { class: 'field' }, h('span', {}, 'Rounds'), roundsSelect),
    h('label', { class: 'field' }, h('span', {}, 'Seed'), seedInput),
    h('label', { class: 'field' }, h('span', {}, 'Target RTP %'), targetInput),
    h('label', { class: 'field' }, h('span', {}, 'Tolerance ± pp'), toleranceInput),
    h('div', { class: 'actions' }, runButton, formError),
  );

  const status = h('div', { class: 'sim-status', 'aria-live': 'polite', hidden: true });
  const result = h('div', { class: 'result' });
  const historyBody = h('tbody');
  const history = h(
    'div',
    { class: 'history' },
    h('h3', {}, 'Recent simulations'),
    h(
      'table',
      { class: 'history-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Game'),
          h('th', { class: 'num' }, 'Rounds'),
          h('th', { class: 'num' }, 'RTP'),
          h('th', {}, 'Verdict'),
          h('th', { class: 'hide-small' }, 'When'),
        ),
      ),
      historyBody,
    ),
  );

  root.replaceChildren(
    h(
      'div',
      { class: 'panel-head' },
      h(
        'div',
        {},
        h('h2', { id: 'simulate-title' }, 'Simulate'),
        h(
          'p',
          {},
          'Monte Carlo in the background (POST /simulations). The same seed always gives the same report.',
        ),
      ),
    ),
    form,
    status,
    result,
    history,
  );

  // ----- rendering -----

  const renderStatus = (sim: Simulation) => {
    status.hidden = false;
    const ms = elapsedMs(sim);
    const rate = ms && ms > 0 ? (sim.roundsDone / ms) * 1000 : 0;
    const label = {
      queued: 'Queued',
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
    }[sim.status];
    const detail =
      sim.status === 'failed'
        ? (sim.error ?? 'unknown error')
        : `${formatInt(sim.roundsDone)} / ${formatInt(sim.spins)} rounds` +
          (ms === null ? '' : ` · ${formatDuration(ms)}`) +
          (rate > 0 ? ` · ${formatCompact(Math.round(rate))} rounds/s` : '');
    const bar = h('div', {
      class: sim.status === 'queued' ? 'progress indeterminate' : 'progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(sim.progress * 100),
    });
    const fill = h('i');
    if (sim.status !== 'queued') fill.style.width = `${sim.progress * 100}%`;
    bar.append(fill);
    status.replaceChildren(
      h(
        'div',
        { class: 'sim-status-line' },
        h(
          'span',
          {},
          h('span', { class: `tag ${sim.status}` }, label),
          ' ',
          `${gameName.get(sim.gameId) ?? sim.gameId} · seed `,
          h('span', { class: 'mono' }, String(sim.seed)),
        ),
        h('span', { class: 'mono' }, detail),
      ),
      ...(sim.status === 'done' ? [] : [bar]),
    );
  };

  const renderResult = (sim: Simulation) => {
    const report = sim.report;
    if (!report) {
      result.replaceChildren();
      return;
    }
    const verdict = sim.verdict;
    const margin = report.rtp - report.interval.low;
    const ms = elapsedMs(sim);

    result.replaceChildren(
      h(
        'div',
        { class: 'hero' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'hero-label' },
            `RTP · ${formatInt(report.rounds)} rounds · `,
            h(
              'a',
              {
                href: api.simulationCsvUrl(sim.id),
                download: `${sim.gameId}-${sim.id.slice(0, 8)}.csv`,
              },
              'CSV',
            ),
          ),
          h('div', { class: 'hero-rtp' }, formatPercent(report.rtp, 3)),
          h(
            'div',
            { class: 'hero-ci' },
            `± ${formatPercent(margin, 3)} · 95% CI ${formatPercent(report.interval.low, 3)} – ${formatPercent(report.interval.high, 3)}`,
          ),
        ),
        verdict
          ? h(
              'div',
              { class: `verdict ${verdict.status}` },
              h('b', {}, verdict.status),
              h(
                'span',
                {},
                `Target ${formatPercent(verdict.target)} ± ${formatPercent(verdict.tolerance)}`,
              ),
              h('small', {}, verdict.reason),
              verdict.roundsNeeded === undefined
                ? null
                : h(
                    'small',
                    {},
                    `About ${formatCompact(verdict.roundsNeeded)} rounds would settle it.`,
                  ),
            )
          : null,
      ),
      h(
        'div',
        {},
        // Drawn at the panel's real width so the labels keep their size on a phone.
        confidenceChart(report, verdict, Math.max(280, Math.round(result.clientWidth || 600))),
        h(
          'p',
          { class: 'ci-caption' },
          verdict
            ? h(
                'span',
                {},
                h('i', {
                  style: 'background: var(--accent-soft); outline: 1px dashed var(--accent)',
                }),
                'allowed range',
              )
            : null,
          h('span', {}, h('i', { style: 'background: currentColor' }), '95% confidence interval'),
          h(
            'span',
            {},
            h('i', { style: 'border: 2px solid currentColor; border-radius: 50%; width: 8px' }),
            'estimate',
          ),
        ),
      ),
      h(
        'dl',
        { class: 'stats' },
        h(
          'div',
          { class: 'stat' },
          h('dt', {}, 'Hit frequency'),
          h(
            'dd',
            {},
            formatPercent(report.hitFrequency),
            h('small', {}, 'rounds that win anything'),
          ),
        ),
        h(
          'div',
          { class: 'stat' },
          h('dt', {}, 'Max win'),
          h('dd', {}, formatMultiplier(report.maxWin), h('small', {}, 'times the total bet')),
        ),
        h(
          'div',
          { class: 'stat' },
          h('dt', {}, 'Volatility'),
          h('dd', {}, report.stdDev.toFixed(2), h('small', {}, 'std dev per round, in bets')),
        ),
        ...(report.featureFrequency > 0
          ? [
              h(
                'div',
                { class: 'stat' },
                h('dt', {}, 'Free spins'),
                h(
                  'dd',
                  {},
                  `1 in ${formatInt(Math.round(1 / report.featureFrequency))}`,
                  h('small', {}, `${formatPercent(report.featureFrequency, 3)} of rounds`),
                ),
              ),
            ]
          : []),
        h(
          'div',
          { class: 'stat' },
          h('dt', {}, 'Run time'),
          h(
            'dd',
            {},
            ms === null ? '—' : formatDuration(ms),
            h(
              'small',
              {},
              ms ? `${formatCompact(Math.round((report.rounds / ms) * 1000))} rounds/s` : '',
            ),
          ),
        ),
      ),
      h('div', { class: 'chart' }, h('h3', {}, 'Where the RTP comes from'), featureChart(report)),
      h(
        'div',
        { class: 'charts' },
        h(
          'div',
          { class: 'chart' },
          h('h3', {}, 'Win distribution (× total bet)'),
          histogramChart(report),
        ),
        h('div', { class: 'chart' }, h('h3', {}, 'RTP by symbol'), symbolChart(report)),
      ),
    );
  };

  const renderHistory = (sims: readonly Simulation[], selected?: string) => {
    if (sims.length === 0) {
      historyBody.replaceChildren(
        h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No simulations yet.')),
      );
      return;
    }
    historyBody.replaceChildren(
      ...sims.map((sim) => {
        const verdictTag = sim.verdict
          ? h('span', { class: `tag ${sim.verdict.status}` }, sim.verdict.status)
          : sim.status === 'done'
            ? h('span', { class: 'tag none' }, 'no target')
            : h('span', { class: `tag ${sim.status}` }, sim.status);
        const row = h(
          'tr',
          {
            class: 'selectable',
            tabindex: 0,
            'aria-selected': sim.id === selected ? 'true' : 'false',
          },
          h('td', {}, gameName.get(sim.gameId) ?? sim.gameId),
          h('td', { class: 'num' }, formatCompact(sim.spins)),
          h('td', { class: 'num' }, sim.report ? formatPercent(sim.report.rtp, 2) : '—'),
          h('td', {}, verdictTag),
          h('td', { class: 'hide-small' }, timeAgo(sim.createdAt)),
        );
        const open = () => void follow(sim.id);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
        return row;
      }),
    );
  };

  const refreshHistory = async (selected?: string) => {
    try {
      renderHistory(await api.listSimulations(8), selected);
    } catch {
      // The history is secondary; the main error banner covers an unreachable API.
    }
  };

  /** Shows a simulation and keeps polling it until it finishes. */
  const follow = async (id: string) => {
    const token = ++runToken;
    let lastStatus = '';
    for (;;) {
      let sim: Simulation;
      try {
        sim = await api.getSimulation(id);
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (token !== runToken) return;
      renderStatus(sim);
      if (sim.status === 'done' || sim.status === 'failed') {
        renderResult(sim);
        runButton.disabled = false;
        await refreshHistory(id);
        return;
      }
      if (lastStatus !== sim.status) {
        result.replaceChildren();
        lastStatus = sim.status;
      }
      await wait(POLL_MS);
    }
  };

  const markInvalid = (input: HTMLInputElement, message: string): never => {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    throw new RangeError(message);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    formError.textContent = '';
    for (const input of [seedInput, targetInput, toleranceInput])
      input.removeAttribute('aria-invalid');

    let seed: number | undefined;
    let target: number | undefined;
    let tolerance: number | undefined;
    try {
      try {
        seed = parseOptionalInt(seedInput.value, 0, 4_294_967_295);
      } catch (e) {
        markInvalid(seedInput, `Seed ${(e as Error).message}.`);
      }
      try {
        target = parseOptionalPercent(targetInput.value);
      } catch (e) {
        markInvalid(targetInput, `Target ${(e as Error).message}.`);
      }
      try {
        tolerance = parseOptionalPercent(toleranceInput.value, 100);
      } catch (e) {
        markInvalid(toleranceInput, `Tolerance ${(e as Error).message}.`);
      }
    } catch (error) {
      formError.textContent = (error as Error).message;
      return;
    }

    runButton.disabled = true;
    const input = {
      gameId: gameSelect.value,
      spins: Number(roundsSelect.value),
      ...(seed === undefined ? {} : { seed }),
      ...(target === undefined ? {} : { target }),
      ...(tolerance === undefined ? {} : { tolerance }),
    };
    void api
      .startSimulation(input)
      .then((sim) => {
        result.replaceChildren();
        renderStatus(sim);
        void refreshHistory(sim.id);
        return follow(sim.id);
      })
      .catch((error: unknown) => {
        runButton.disabled = false;
        formError.textContent =
          error instanceof ApiRequestError
            ? [error.message, ...error.issues].join(' ')
            : 'The simulation could not be started.';
      });
  });

  const preferred = games.find((g) => g.id === 'fruits-96') ?? games[0];
  if (preferred) gameSelect.value = preferred.id;

  // Show the latest finished simulation straight away, so the panel is never empty.
  void api
    .listSimulations(8)
    .then((sims) => {
      renderHistory(sims, sims[0]?.id);
      const latest = sims[0];
      if (latest) void follow(latest.id);
    })
    .catch(() => renderHistory([]));
}
