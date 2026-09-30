/**
 * Analyze view: runs the analytics package in a Web Worker for up to three games and shows how
 * they differ for a player: percentiles, how long 100 credits last, the chance of being ahead,
 * losing streaks, and how fast the RTP estimate settles.
 */
import {
  analysisToJson,
  comparisonToCsv,
  type ComparisonRow,
  type GameAnalysis,
} from '@slottestyfer/analytics';
import type { AnalysisMessage, AnalysisRequest } from './analysis.worker.js';
import { api, type GameSummary } from './api.js';
import { lineChart } from './chart.js';
import { h } from './dom.js';
import { formatCompact, formatDuration, formatInt, formatPercent } from './lib/format.js';

/** One colour per compared game, readable in light and dark mode. */
export const GAME_COLOURS = ['#2f9e6e', '#e8590c', '#7950f2'];

const MAX_GAMES = 3;

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatCell(row: ComparisonRow, value: number | string): string {
  if (typeof value === 'string') return value;
  switch (row.unit) {
    case 'fraction':
      return formatPercent(value, value < 0.01 && value > 0 ? 3 : 2);
    case 'rounds':
      return formatInt(value);
    case 'credits':
      return value.toFixed(0);
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

export function mountAnalyze(root: HTMLElement, games: readonly GameSummary[]): void {
  const checks = games.map((game, i) =>
    h('input', {
      type: 'checkbox',
      value: game.id,
      checked: i < MAX_GAMES && ['fruits-96', 'fruits-88', 'fruits-5x3'].includes(game.id),
    }),
  );
  const roundsSelect = h(
    'select',
    {},
    ...[20_000, 100_000, 250_000].map((n) => h('option', { value: n }, formatCompact(n))),
  );
  roundsSelect.value = '100000';
  const sessionsSelect = h(
    'select',
    {},
    ...[200, 500, 1000].map((n) => h('option', { value: n }, String(n))),
  );
  sessionsSelect.value = '500';
  const seedInput = h('input', { type: 'text', inputmode: 'numeric', value: '42' });
  const runButton = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Analyze');
  const formError = h('span', { class: 'form-error', role: 'alert' });
  const progress = h('div', { class: 'sim-status', hidden: true, 'aria-live': 'polite' });
  const output = h('div', { class: 'analysis' });

  const form = h(
    'form',
    { class: 'analyze-form', novalidate: true },
    h(
      'fieldset',
      { class: 'game-picks' },
      h('legend', {}, `Games (up to ${MAX_GAMES})`),
      ...games.map((game, i) =>
        h(
          'label',
          { class: 'pick' },
          checks[i] ?? null,
          h('span', {}, game.name),
          h('small', { class: 'num' }, formatPercent(game.rtp)),
        ),
      ),
    ),
    h(
      'div',
      { class: 'sim-form' },
      h('label', { class: 'field' }, h('span', {}, 'Rounds per game'), roundsSelect),
      h('label', { class: 'field' }, h('span', {}, 'Player sessions'), sessionsSelect),
      h('label', { class: 'field' }, h('span', {}, 'Seed'), seedInput),
      h('div', { class: 'actions' }, runButton, formError),
    ),
  );

  root.replaceChildren(
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'analyze-title' },
      h(
        'div',
        { class: 'panel-head' },
        h(
          'div',
          {},
          h('h2', { id: 'analyze-title' }, 'Analyze'),
          h(
            'p',
            {},
            'Runs in your browser, in a Web Worker, with the same engine as the server. ' +
              'Each player starts with 100 credits and bets 1 per round, for up to 1,000 rounds.',
          ),
        ),
      ),
      form,
      progress,
      output,
    ),
  );

  let worker: Worker | null = null;

  const renderProgress = (message: Extract<AnalysisMessage, { type: 'progress' }>) => {
    const name = games.find((g) => g.id === checked()[message.game])?.name ?? '';
    const overall =
      (message.game + (message.stage === 'rounds' ? 0 : 0.5) + message.fraction / 2) /
      message.games;
    const bar = h('div', { class: 'progress' }, h('i', { style: `width: ${overall * 100}%` }));
    progress.hidden = false;
    progress.replaceChildren(
      h(
        'div',
        { class: 'sim-status-line' },
        h(
          'span',
          {},
          h('span', { class: 'tag running' }, 'Running'),
          ` ${name}: `,
          message.stage === 'rounds' ? 'sampling rounds' : 'playing sessions',
        ),
        h('span', { class: 'mono' }, formatPercent(overall, 0)),
      ),
      bar,
    );
  };

  const checked = () => checks.filter((c) => c.checked).map((c) => c.value);

  const renderResults = (
    analyses: GameAnalysis[],
    rows: ComparisonRow[],
    words: string[][],
    ms: number,
  ) => {
    const width = Math.max(300, Math.round(output.clientWidth || 800));
    const half = width >= 900 ? Math.floor((width - 20) / 2) : width;
    const colour = (i: number) => GAME_COLOURS[i % GAME_COLOURS.length] ?? '#2f9e6e';
    const pct = (v: number) => formatPercent(v, 1);

    const legend = h(
      'ul',
      { class: 'legend chart-legend' },
      ...analyses.map((a, i) =>
        h('li', {}, h('i', { style: `background: ${colour(i)}` }), a.game.name),
      ),
    );

    const convergence = lineChart({
      width: half,
      height: 240,
      xLog: true,
      series: analyses.map((a, i) => ({
        label: a.game.name,
        color: colour(i),
        points: a.convergence.map((p) => ({ x: p.rounds, y: p.rtp })),
        band: a.convergence.map((p) => ({ x: p.rounds, low: p.low, high: p.high })),
      })),
      rules: analyses.map((a) => ({ y: a.exact.rtp })),
      xFormat: formatCompact,
      yFormat: (v) => formatPercent(v, 0),
      ariaLabel: 'RTP estimate as rounds accumulate, with its 95% confidence band',
    });

    const survival = lineChart({
      width: half,
      height: 240,
      yDomain: [0, 1],
      series: analyses.map((a, i) => ({
        label: a.game.name,
        color: colour(i),
        points: [
          { x: 0, y: 1 },
          ...a.sessions.survival.map((share, r) => ({ x: r + 1, y: share })),
        ],
      })),
      xFormat: formatCompact,
      yFormat: (v) => formatPercent(v, 0),
      ariaLabel: 'Share of players still playing after each round',
    });

    const trajectories = analyses.map((a, i) =>
      h(
        'div',
        { class: 'chart' },
        h('h3', {}, `${a.game.name}: balance of ${a.sessions.trajectories.length} players`),
        lineChart({
          width:
            analyses.length > 1 && width >= 900
              ? Math.floor((width - 20 * (analyses.length - 1)) / analyses.length)
              : width,
          height: 200,
          series: a.sessions.trajectories.map((path, p) => ({
            label: `player ${p + 1}`,
            color: colour(i),
            width: 1.2,
            opacity: 0.55,
            points: [
              { x: 0, y: a.sessions.startBalance },
              ...path.map((balance, r) => ({ x: r + 1, y: balance })),
            ],
          })),
          rules: [{ y: a.sessions.startBalance }],
          xFormat: formatCompact,
          yFormat: (v) => v.toFixed(0),
          ariaLabel: `Balance of ${a.sessions.trajectories.length} players of ${a.game.name}`,
        }),
      ),
    );

    const jsonButton = h('button', { class: 'btn', type: 'button' }, 'Download JSON');
    const csvButton = h('button', { class: 'btn', type: 'button' }, 'Download CSV');
    jsonButton.addEventListener('click', () =>
      download('slottestyfer-analysis.json', analysisToJson(analyses), 'application/json'),
    );
    csvButton.addEventListener('click', () =>
      download(
        'slottestyfer-comparison.csv',
        comparisonToCsv(
          analyses.map((a) => a.game),
          rows,
        ),
        'text/csv',
      ),
    );

    output.replaceChildren(
      h(
        'div',
        { class: 'analysis-head' },
        h(
          'p',
          { class: 'muted' },
          `${formatInt(analyses[0]?.report.rounds ?? 0)} rounds and ${formatInt(analyses[0]?.sessions.sessions ?? 0)} sessions per game, in ${formatDuration(ms)}.`,
        ),
        h('div', { class: 'actions' }, jsonButton, csvButton),
      ),
      h(
        'div',
        { class: 'words' },
        ...analyses.map((a, i) =>
          h(
            'article',
            { class: 'word-card', style: `--game: ${colour(i)}` },
            h('h3', {}, a.game.name),
            h('ul', {}, ...(words[i] ?? []).map((line) => h('li', {}, line))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'history-table compare-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, 'Metric'),
              ...analyses.map((a, i) =>
                h('th', { class: 'num', style: `color: ${colour(i)}` }, a.game.name),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                {},
                h('td', {}, row.metric),
                ...row.values.map((v) => h('td', { class: 'num' }, formatCell(row, v))),
              ),
            ),
          ),
        ),
      ),
      legend,
      h(
        'div',
        { class: 'charts two' },
        h(
          'div',
          { class: 'chart' },
          h('h3', {}, 'RTP estimate as rounds accumulate (95% band, exact RTP dashed)'),
          convergence,
        ),
        h(
          'div',
          { class: 'chart' },
          h('h3', {}, 'Players still playing (100 credits, 1 per round)'),
          survival,
        ),
      ),
      h('div', { class: 'charts many' }, ...trajectories),
      h(
        'p',
        { class: 'muted small' },
        `Percentiles are of the win per round in bets; ${pct(analyses[0]?.wins.zeroShare ?? 0)} of ${analyses[0]?.game.name ?? ''} rounds win nothing.`,
      ),
    );
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    formError.textContent = '';
    const ids = checked();
    if (ids.length === 0 || ids.length > MAX_GAMES) {
      formError.textContent = `Pick between 1 and ${MAX_GAMES} games.`;
      return;
    }
    const seed = Number(seedInput.value.trim() || '42');
    if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
      formError.textContent = 'Seed must be a whole number from 0 to 4,294,967,295.';
      return;
    }

    runButton.disabled = true;
    worker?.terminate();
    void Promise.all(ids.map((id) => api.getGame(id)))
      .then((configs) => {
        worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
        worker.addEventListener('message', (e: MessageEvent<AnalysisMessage>) => {
          const message = e.data;
          if (message.type === 'progress') renderProgress(message);
          else {
            runButton.disabled = false;
            progress.hidden = true;
            worker?.terminate();
            worker = null;
            if (message.type === 'error') formError.textContent = message.message;
            else renderResults(message.analyses, message.rows, message.words, message.ms);
          }
        });
        const request: AnalysisRequest = {
          configs,
          rounds: Number(roundsSelect.value),
          sessions: Number(sessionsSelect.value),
          maxRounds: 1000,
          balance: 100,
          seed,
        };
        worker.postMessage(request);
      })
      .catch((error: unknown) => {
        runButton.disabled = false;
        formError.textContent = error instanceof Error ? error.message : String(error);
      });
  });
}
