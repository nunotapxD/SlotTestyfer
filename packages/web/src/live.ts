/**
 * Live view: two games side by side, each playing continuously on the server. Numbers arrive
 * every 100 ms over Server-Sent Events: the running RTP with its confidence band closing in, the
 * live verdict (provisional until the band fits), virtual players' balances and alerts.
 */
import {
  api,
  ApiRequestError,
  type GameSummary,
  type LiveAlert,
  type LiveBatch,
  type LiveSnapshot,
  type LiveState,
  type LiveStatus,
} from './api.js';
import { GAME_COLOURS } from './analyze.js';
import { lineChart } from './chart.js';
import { h } from './dom.js';
import { formatCompact, formatInt, formatMultiplier, formatPercent } from './lib/format.js';

const SPEEDS: [string, number][] = [
  ['1k rounds/s', 1_000],
  ['10k rounds/s', 10_000],
  ['100k rounds/s', 100_000],
  ['As fast as possible', 0],
];

interface Point {
  rounds: number;
  rtp: number;
  low: number;
  high: number;
  players: number[];
  playerRounds: number;
}

interface Lane {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly disconnect: () => void;
}

function mountLane(
  root: HTMLElement,
  games: readonly GameSummary[],
  defaultGame: string,
  colour: string,
): Lane {
  let run: LiveState | null = null;
  let source: EventSource | null = null;
  let history: Point[] = [];
  let alerts: LiveAlert[] = [];
  let last: LiveBatch | null = null;
  let status: LiveStatus | 'idle' = 'idle';
  let frame = 0;

  const gameSelect = h('select', {}, ...games.map((g) => h('option', { value: g.id }, g.name)));
  gameSelect.value = games.some((g) => g.id === defaultGame) ? defaultGame : (games[0]?.id ?? '');
  const speedSelect = h(
    'select',
    {},
    ...SPEEDS.map(([label, v]) => h('option', { value: v }, label)),
  );
  speedSelect.value = '10000';
  const startButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start');
  const pauseButton = h('button', { class: 'btn', type: 'button', disabled: true }, 'Pause');
  const cancelButton = h('button', { class: 'btn', type: 'button', disabled: true }, 'Stop');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const statusTag = h('span', { class: 'tag none' }, 'idle');
  const body = h('div', { class: 'lane-body' });

  root.replaceChildren(
    h(
      'div',
      { class: 'lane-head', style: `--game: ${colour}` },
      h('label', { class: 'field' }, h('span', {}, 'Game'), gameSelect),
      h('label', { class: 'field' }, h('span', {}, 'Speed'), speedSelect),
      h('div', { class: 'lane-actions' }, startButton, pauseButton, cancelButton, statusTag),
    ),
    error,
    body,
  );

  const renderStatus = () => {
    const running = status === 'running' || status === 'paused';
    startButton.disabled = running;
    gameSelect.disabled = running;
    pauseButton.disabled = !running;
    cancelButton.disabled = !running;
    pauseButton.textContent = status === 'paused' ? 'Resume' : 'Pause';
    statusTag.className = `tag ${status === 'running' ? 'running' : status === 'finished' ? 'done' : status === 'failed' ? 'failed' : 'none'}`;
    statusTag.textContent = status;
  };

  const render = () => {
    frame = 0;
    if (!run || !last) {
      body.replaceChildren(
        h('p', { class: 'empty' }, 'Press Start to play this game continuously.'),
      );
      return;
    }
    const width = Math.max(260, Math.round(body.clientWidth || 500));
    const { target, tolerance } = run.settings;
    const players = last.players;
    const v = last.verdict;
    const tiles: [string, string, string?][] = [
      ['Rounds', formatCompact(last.rounds), `${formatCompact(last.roundsPerSecond)}/s`],
      ['Hit frequency', formatPercent(last.hitFrequency)],
      ['Max win', formatMultiplier(last.maxWin)],
      ['Losing streak', String(last.longestLosingStreak), 'longest so far'],
    ];

    body.replaceChildren(
      h(
        'div',
        { class: 'hero' },
        h(
          'div',
          {},
          h('div', { class: 'hero-label' }, `${run.game.name} · RTP`),
          h('div', { class: 'hero-rtp' }, formatPercent(last.rtp, 3)),
          h(
            'div',
            { class: 'hero-ci' },
            `95% CI ${formatPercent(last.low, 3)} – ${formatPercent(last.high, 3)}`,
          ),
        ),
        h(
          'div',
          { class: `verdict ${v.status}` },
          h('b', {}, v.status),
          h('span', {}, `Target ${formatPercent(target)} ± ${formatPercent(tolerance)}`),
          h(
            'small',
            {},
            v.final
              ? 'final: the interval no longer crosses a limit'
              : 'provisional: more rounds needed',
          ),
        ),
      ),
      h(
        'dl',
        { class: 'stats' },
        ...tiles.map(([label, value, note]) =>
          h(
            'div',
            { class: 'stat' },
            h('dt', {}, label),
            h('dd', {}, value, note ? h('small', {}, note) : null),
          ),
        ),
      ),
      h(
        'div',
        { class: 'chart' },
        h('h3', {}, 'RTP and its 95% band (allowed range shaded)'),
        lineChart({
          width,
          height: 200,
          xLog: true,
          xDomain: [Math.max(1, history[0]?.rounds ?? 1), Math.max(10, last.rounds)],
          series: [
            {
              label: 'RTP',
              color: colour,
              points: history.map((p) => ({ x: p.rounds, y: p.rtp })),
              band: history.map((p) => ({ x: p.rounds, low: p.low, high: p.high })),
            },
          ],
          bands: [{ y0: target - tolerance, y1: target + tolerance }],
          yDomain: [
            Math.min(target - 3 * tolerance, ...history.slice(-60).map((p) => p.low)),
            Math.max(target + 3 * tolerance, ...history.slice(-60).map((p) => p.high)),
          ],
          xFormat: formatCompact,
          yFormat: (y) => formatPercent(y, 1),
          ariaLabel: `RTP of ${run.game.name}: ${formatPercent(last.rtp)}`,
        }),
      ),
      h(
        'div',
        { class: 'chart' },
        h('h3', {}, `${players.length} virtual players, 100 credits each (1 per round)`),
        lineChart({
          width,
          height: 170,
          series: players.map((player, i) => ({
            label: `player ${player.id + 1}`,
            color: colour,
            width: 1.3,
            opacity: 0.35 + (0.6 * (i + 1)) / players.length,
            points: [
              { x: 0, y: 100 },
              ...history.map((p) => ({ x: p.playerRounds, y: p.players[i] ?? 0 })),
            ],
          })),
          rules: [{ y: 100 }],
          xFormat: formatCompact,
          yFormat: (y) => y.toFixed(0),
          ariaLabel: 'Balances of the virtual players',
        }),
      ),
      h(
        'div',
        { class: 'alerts' },
        h('h3', {}, 'Alerts'),
        alerts.length === 0
          ? h('p', { class: 'empty' }, 'None so far.')
          : h(
              'ul',
              {},
              ...alerts
                .slice(-5)
                .reverse()
                .map((a) =>
                  h(
                    'li',
                    { class: `alert ${a.kind}` },
                    h('span', { class: 'mono' }, `${formatInt(a.rounds)}`),
                    a.message,
                  ),
                ),
            ),
      ),
    );
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  const connect = (id: string) => {
    source?.close();
    source = new EventSource(api.liveEventsUrl(id));
    source.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot;
      run = snap;
      history = snap.history.map((p) => ({ ...p }));
      alerts = [...snap.alerts];
      last = snap.last;
      status = snap.status;
      renderStatus();
      schedule();
    });
    source.addEventListener('batch', (e) => {
      const batch = JSON.parse((e as MessageEvent<string>).data) as LiveBatch;
      last = batch;
      alerts.push(...batch.alerts);
      history.push({
        rounds: batch.rounds,
        rtp: batch.rtp,
        low: batch.low,
        high: batch.high,
        players: batch.players.map((p) => p.balance),
        playerRounds: Math.max(0, ...batch.players.map((p) => p.rounds)),
      });
      if (history.length > 600)
        history = history.filter((_, i) => i % 2 === 0 || i === history.length - 1);
      schedule();
    });
    source.addEventListener('status', (e) => {
      status = (JSON.parse((e as MessageEvent<string>).data) as { status: LiveStatus }).status;
      renderStatus();
      if (status !== 'running' && status !== 'paused') {
        source?.close();
        source = null;
      }
    });
  };

  const act = async (fn: () => Promise<unknown>) => {
    error.textContent = '';
    try {
      await fn();
    } catch (e) {
      error.textContent = e instanceof ApiRequestError ? e.message : String(e);
    }
  };

  const start = () =>
    act(async () => {
      history = [];
      alerts = [];
      last = null;
      run = await api.startLive({
        gameId: gameSelect.value,
        roundsPerSecond: Number(speedSelect.value),
        target: 0.96,
        tolerance: 0.005,
        players: 8,
      });
      status = run.status;
      renderStatus();
      connect(run.id);
    });

  const stop = () =>
    act(async () => {
      if (run && (status === 'running' || status === 'paused'))
        await api.liveCommand(run.id, 'cancel');
    });

  startButton.addEventListener('click', () => void start());
  cancelButton.addEventListener('click', () => void stop());
  pauseButton.addEventListener('click', () => {
    if (!run) return;
    const id = run.id;
    void act(() => api.liveCommand(id, status === 'paused' ? 'resume' : 'pause'));
  });
  speedSelect.addEventListener('change', () => {
    if (run && (status === 'running' || status === 'paused')) {
      const id = run.id;
      void act(() => api.liveSpeed(id, Number(speedSelect.value)));
    }
  });

  renderStatus();
  render();
  return {
    start,
    stop,
    disconnect: () => {
      source?.close();
      source = null;
    },
  };
}

export function mountLive(root: HTMLElement, games: readonly GameSummary[]): () => void {
  const left = h('div', { class: 'lane panel' });
  const right = h('div', { class: 'lane panel' });
  const startBoth = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start both');
  const stopBoth = h('button', { class: 'btn', type: 'button' }, 'Stop both');

  root.replaceChildren(
    h(
      'section',
      { class: 'panel live-intro', 'aria-labelledby': 'live-title' },
      h(
        'div',
        { class: 'panel-head' },
        h(
          'div',
          {},
          h('h2', { id: 'live-title' }, 'Live'),
          h(
            'p',
            {},
            'Two games playing continuously on the server, each in its own worker thread. ' +
              'Numbers stream over Server-Sent Events every 100 ms. The verdict stays provisional ' +
              'until the confidence band fits inside, or falls outside, 96% ± 0.5%.',
          ),
        ),
        h('div', { class: 'lane-actions' }, startBoth, stopBoth),
      ),
    ),
    h('div', { class: 'lanes' }, left, right),
  );

  const lanes = [
    mountLane(left, games, 'fruits-96', GAME_COLOURS[0] ?? '#2f9e6e'),
    mountLane(right, games, 'fruits-88', GAME_COLOURS[1] ?? '#e8590c'),
  ];
  startBoth.addEventListener('click', () => void Promise.all(lanes.map((l) => l.start())));
  stopBoth.addEventListener('click', () => void Promise.all(lanes.map((l) => l.stop())));
  return () => lanes.forEach((l) => l.disconnect());
}
