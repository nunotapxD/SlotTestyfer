/**
 * The game screen: reels, fictional balance, bet, spin, and the winning lines drawn on top.
 * Every round is played by the API (POST /spin); this file only shows it.
 */
import {
  api,
  ApiRequestError,
  type GameConfig,
  type GameSummary,
  type LineWin,
  type Round,
  type ScatterWin,
} from './api.js';
import { h, prefersReducedMotion, s, wait } from './dom.js';
import { formatCredits, formatMultiplier } from './lib/format.js';
import {
  betOptions,
  linePoints,
  spinningSymbols,
  STARTING_BALANCE,
  winningCells,
  type Grid,
} from './lib/game.js';
import { symbolLook } from './lib/symbols.js';

/** Colours for winning paylines, picked by payline index so a line keeps its colour. */
export const LINE_COLOURS = ['#f2b53a', '#4cc9f0', '#f47ba6', '#8be28b', '#b69cff', '#ff9f5a'];

const lineColour = (payline: number) => LINE_COLOURS[payline % LINE_COLOURS.length] ?? '#f2b53a';

/** One symbol tile. Used by the reels, the paytable and the simulator's symbol chart. */
export function symbolCell(id: string, extraClass = ''): HTMLDivElement {
  const look = symbolLook(id);
  return h(
    'div',
    {
      class: ['cell', look.isText ? 'text' : '', extraClass].filter(Boolean).join(' '),
      style: `--hue: ${look.hue}`,
      title: look.label,
    },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, look.glyph),
    h('span', { class: 'sr-only' }, look.label),
  );
}

export function mountGame(
  root: HTMLElement,
  games: readonly GameSummary[],
  showError: (message: string) => void,
): void {
  const state = {
    config: null as GameConfig | null,
    screen: [] as string[][],
    balance: STARTING_BALANCE,
    /** Index into the per-line bet options, kept when switching games. */
    betIndex: 2,
    spinning: false,
    lastRound: null as Round | null,
  };

  // ----- static structure -----

  const gameSelect = h(
    'select',
    { id: 'play-game', 'aria-label': 'Game' },
    ...games.map((g) => h('option', { value: g.id }, g.name)),
  );
  const reelsEl = h('div', { class: 'reels', role: 'img', 'aria-label': 'Reels' });
  const bannerText = h('span', { class: 'fs-text' });
  const skipButton = h('button', { class: 'link-btn fs-skip', type: 'button' }, 'Skip');
  const banner = h(
    'div',
    { class: 'fs-banner', hidden: true, 'aria-live': 'polite' },
    bannerText,
    skipButton,
  );
  const machine = h('div', { class: 'machine' }, reelsEl, banner);
  let skipFeature = false;
  skipButton.addEventListener('click', () => {
    skipFeature = true;
  });

  const balanceValue = h('span', { class: 'meter-value' });
  const topUp = h('button', { class: 'link-btn', type: 'button', hidden: true }, 'Top up');
  const betValue = h('span', { class: 'meter-value' });
  const betDown = h('button', { type: 'button', 'aria-label': 'Lower bet' }, '−');
  const betUp = h('button', { type: 'button', 'aria-label': 'Raise bet' }, '+');
  const lastWinValue = h('span', { class: 'meter-value' }, '0.00');
  const spinButton = h(
    'button',
    { class: 'btn btn-primary spin-btn', type: 'button' },
    'Spin',
    h('span', { class: 'kbd', 'aria-hidden': 'true' }, 'Space'),
  );
  const info = h('div', { class: 'round-info', 'aria-live': 'polite' });
  const paytable = h('details', { class: 'paytable' });

  root.replaceChildren(
    h(
      'div',
      { class: 'panel-head' },
      h(
        'div',
        {},
        h('h2', { id: 'play-title' }, 'Play'),
        h('p', {}, 'Each round is played by the engine through POST /spin.'),
      ),
    ),
    h(
      'div',
      { class: 'game-toolbar' },
      h('label', { class: 'field' }, h('span', {}, 'Game'), gameSelect),
    ),
    machine,
    h(
      'div',
      { class: 'meters' },
      h(
        'div',
        { class: 'meter' },
        h('span', { class: 'meter-label' }, 'Balance ', topUp),
        balanceValue,
      ),
      h(
        'div',
        { class: 'meter' },
        h('span', { class: 'meter-label' }, 'Bet'),
        h('div', { class: 'bet-control' }, betDown, betValue, betUp),
      ),
      h('div', { class: 'meter' }, h('span', { class: 'meter-label' }, 'Last win'), lastWinValue),
    ),
    h('div', { class: 'spin-row' }, spinButton),
    info,
    paytable,
  );

  // ----- helpers -----

  const bets = () => betOptions(state.config?.paylines.length ?? 1);
  const currentBet = () => bets()[state.betIndex] ?? bets()[0] ?? 1;

  const renderMeters = () => {
    balanceValue.textContent = formatCredits(state.balance);
    betValue.textContent = formatCredits(currentBet());
    const broke = state.balance < currentBet();
    topUp.hidden = !broke;
    betDown.disabled = state.spinning || state.betIndex === 0;
    betUp.disabled = state.spinning || state.betIndex >= bets().length - 1;
    spinButton.disabled = state.spinning || !state.config || broke;
    gameSelect.disabled = state.spinning;
  };

  const grid = (): Grid => {
    const cell = reelsEl.querySelector('.cell');
    const strip = reelsEl.querySelector('.strip');
    return {
      cell: cell?.getBoundingClientRect().height ?? 88,
      gap: strip ? parseFloat(getComputedStyle(strip).rowGap) || 0 : 0,
    };
  };

  const clearHighlights = () => {
    machine.classList.remove('has-win');
    reelsEl.querySelectorAll('.cell.win').forEach((c) => c.classList.remove('win'));
    reelsEl.querySelector('.paylines')?.remove();
  };

  /** Shows a screen with no animation. */
  const setScreen = (screen: string[][]) => {
    state.screen = screen;
    const reels = screen.map((column, reel) =>
      h(
        'div',
        { class: 'reel', 'data-reel': reel },
        h(
          'div',
          { class: 'strip' },
          ...column.map((symbol, row) => {
            const cell = symbolCell(symbol);
            cell.dataset['pos'] = `${reel}:${row}`;
            return cell;
          }),
        ),
      ),
    );
    reelsEl.replaceChildren(...reels);
    reelsEl.style.gridTemplateColumns = `repeat(${screen.length}, var(--cell))`;
    reelsEl.style.setProperty('--rows', String(state.config?.rows ?? 3));
    // Cells shrink to fit five reels on a phone (see .reels in styles.css).
    reelsEl.style.setProperty('--reels', String(screen.length));
  };

  /** Spins each reel down to the final screen, stopping left to right. */
  const animateTo = async (final: string[][], fast = false) => {
    const config = state.config;
    if (!config || prefersReducedMotion()) {
      setScreen(final);
      return;
    }
    const { cell, gap } = grid();
    const step = cell + gap;
    const reels = [...reelsEl.querySelectorAll<HTMLElement>('.reel')];

    await Promise.all(
      reels.map(
        (reel, i) =>
          new Promise<void>((resolve) => {
            const strip = reel.querySelector<HTMLElement>('.strip');
            if (!strip) return resolve();
            // Top to bottom: the final symbols, random ones scrolling past, then what was showing.
            // Moving from the bottom of that strip to the top makes the symbols travel downwards.
            const symbols = [
              ...(final[i] ?? []),
              ...spinningSymbols(config.reels[i] ?? [], fast ? 6 + i * 2 : 12 + i * 5),
              ...(state.screen[i] ?? []),
            ];
            strip.replaceChildren(...symbols.map((symbol) => symbolCell(symbol)));
            const distance = (symbols.length - config.rows) * step;
            strip.style.transition = 'none';
            strip.style.transform = `translateY(${-distance}px)`;
            void strip.offsetHeight; // apply the start position before animating
            const duration = fast ? 300 + i * 110 : 650 + i * 260;
            strip.style.transition = `transform ${duration}ms cubic-bezier(0.18, 0.8, 0.25, 1)`;
            strip.style.transform = 'translateY(0)';
            let finished = false;
            const done = () => {
              if (finished) return;
              finished = true;
              resolve();
            };
            strip.addEventListener('transitionend', done, { once: true });
            setTimeout(done, duration + 120);
          }),
      ),
    );
    setScreen(final);
  };

  /** Marks the winning symbols and draws the winning paylines of one spin. */
  const highlight = (round: {
    screen: string[][];
    lineWins: LineWin[];
    scatterWins: ScatterWin[];
  }) => {
    const wins = [...round.lineWins, ...round.scatterWins];
    if (wins.length === 0) return;
    machine.classList.add('has-win');
    const cells = winningCells(wins);
    reelsEl.querySelectorAll<HTMLElement>('.cell').forEach((c) => {
      if (cells.has(c.dataset['pos'] ?? '')) c.classList.add('win');
    });

    const g = grid();
    const reels = round.screen.length;
    const rows = state.config?.rows ?? 3;
    const width = reels * g.cell + (reels - 1) * g.gap;
    const height = rows * g.cell + (rows - 1) * g.gap;
    const svg = s(
      'svg',
      { class: 'paylines', viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
      ...round.lineWins.map((win) =>
        s('polyline', {
          points: linePoints(win.positions, g)
            .map((p) => `${p.x},${p.y}`)
            .join(' '),
          stroke: lineColour(win.payline),
        }),
      ),
    );
    reelsEl.append(svg);
  };

  const renderInfo = (round: Round) => {
    const wins = [
      ...round.lineWins.map((w) =>
        h(
          'li',
          {},
          h('span', { class: 'swatch', style: `background: ${lineColour(w.payline)}` }),
          `Line ${w.payline + 1}: ${w.count} × ${symbolLook(w.symbol).label}`,
          h('span', { class: 'amount' }, `+${formatCredits(w.win)}`),
        ),
      ),
      ...round.scatterWins.map((w) =>
        h(
          'li',
          {},
          h('span', { class: 'swatch', style: 'background: var(--gold)' }),
          `Scatter: ${w.count} × ${symbolLook(w.symbol).label} anywhere`,
          h('span', { class: 'amount' }, `+${formatCredits(w.win)}`),
        ),
      ),
      ...(round.freeSpins
        ? [
            h(
              'li',
              { class: 'fs-line' },
              h('span', { class: 'swatch', style: 'background: var(--accent)' }),
              `Free spins: ${round.freeSpins.spins.length} rounds, wins ×${round.freeSpins.multiplier}`,
              h('span', { class: 'amount' }, `+${formatCredits(round.freeSpins.win)}`),
            ),
          ]
        : []),
    ];
    const replay = h('button', { class: 'link-btn', type: 'button' }, 'Replay this round');
    replay.addEventListener('click', () => void play(round.seed));

    info.replaceChildren(
      round.win > 0
        ? h(
            'p',
            { class: 'headline win' },
            `Win ${formatCredits(round.win)} (${formatMultiplier(round.multiplier)} the bet)`,
          )
        : h('p', { class: 'headline' }, 'No win this round'),
      ...(wins.length > 0 ? [h('ul', { class: 'win-list' }, ...wins)] : []),
      h(
        'div',
        { class: 'round-meta' },
        h('span', { class: 'mono' }, `seed ${round.seed}`),
        h('span', { class: 'mono' }, `stops ${round.stops.join(' · ')}`),
        replay,
      ),
    );
  };

  const renderPaytable = (config: GameConfig) => {
    const kinds = new Map(config.symbols.map((sym) => [sym.id, sym.kind]));
    const items = config.symbols.map((sym) => {
      const pays = config.paytable
        .filter((p) => p.symbol === sym.id)
        .sort((a, b) => a.count - b.count)
        .map((p) => h('span', {}, `${p.count}× ${p.pays}`));
      return h(
        'div',
        { class: 'pay-item' },
        symbolCell(sym.id),
        h(
          'div',
          {},
          h('div', {}, symbolLook(sym.id).label),
          sym.kind === 'regular' ? null : h('div', { class: 'kind' }, sym.kind),
          h('div', { class: 'pays' }, ...(pays.length > 0 ? pays : [h('span', {}, '—')])),
        ),
      );
    });
    const hasScatter = [...kinds.values()].includes('scatter');
    paytable.replaceChildren(
      h('summary', {}, `Paytable · ${config.paylines.length} paylines`),
      h('div', { class: 'paytable-grid' }, ...items),
      h(
        'p',
        { class: 'paytable-note' },
        `Line prizes multiply the line bet (bet ÷ ${config.paylines.length}). `,
        hasScatter ? 'Scatter prizes multiply the total bet. ' : '',
        'Wilds replace any regular symbol.',
        config.freeSpins
          ? ` ${config.freeSpins.count}+ ${symbolLook(config.freeSpins.symbol).label} anywhere: ` +
              `${config.freeSpins.spins} free spins, every win ×${config.freeSpins.multiplier}.`
          : '',
      ),
    );
  };

  const loadGame = async (id: string) => {
    try {
      const config = await api.getGame(id);
      state.config = config;
      state.lastRound = null;
      clearHighlights();
      setScreen(config.reels.map((strip) => strip.slice(0, config.rows)));
      renderPaytable(config);
      info.replaceChildren(
        h('p', { class: 'headline' }, `${config.name}`),
        h(
          'div',
          { class: 'round-meta' },
          `${config.reels.length} reels × ${config.rows} rows · ${config.paylines.length} paylines · `,
          'press Spin or the space bar',
        ),
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
    renderMeters();
  };

  /** Shows the free spins one after another (all already decided by the API). */
  const playFeature = async (round: Round) => {
    const feature = round.freeSpins;
    if (!feature) return;
    const total = feature.spins.length;
    skipFeature = false;
    banner.hidden = false;
    bannerText.textContent = `FREE SPINS ×${total} · wins ×${feature.multiplier}`;
    skipButton.hidden = false;
    await wait(prefersReducedMotion() ? 0 : 1100);

    let won = 0;
    for (const [i, spin] of feature.spins.entries()) {
      if (skipFeature) break;
      clearHighlights();
      await animateTo(spin.screen, true);
      highlight(spin);
      won += spin.win;
      bannerText.textContent = `Free spin ${i + 1}/${total} · ×${feature.multiplier} · won ${formatCredits(won)}`;
      await wait(prefersReducedMotion() ? 0 : spin.win > 0 ? 650 : 280);
    }
    if (skipFeature) {
      const last = feature.spins[total - 1];
      if (last) {
        clearHighlights();
        setScreen(last.screen);
        highlight(last);
      }
    }
    skipButton.hidden = true;
    bannerText.textContent = `Free spins won ${formatCredits(feature.win)}`;
    await wait(prefersReducedMotion() ? 0 : 900);
    banner.hidden = true;
    // Back to the base spin, whose wins the round summary lists.
    clearHighlights();
    setScreen(round.screen);
    highlight(round);
  };

  const play = async (seed?: number) => {
    const config = state.config;
    if (!config || state.spinning) return;
    const bet = currentBet();
    if (bet > state.balance) return;

    state.spinning = true;
    clearHighlights();
    state.balance -= bet;
    renderMeters();

    try {
      const round = await api.spin(config.id, bet, seed);
      await animateTo(round.screen);
      highlight(round);
      if (round.freeSpins) await playFeature(round);
      state.balance += round.win;
      state.lastRound = round;
      lastWinValue.textContent = formatCredits(round.win);
      lastWinValue.classList.toggle('positive', round.win > 0);
      renderInfo(round);
    } catch (error) {
      state.balance += bet;
      const message =
        error instanceof ApiRequestError ? error.message : 'The round could not be played.';
      info.replaceChildren(h('p', { class: 'error' }, message));
    } finally {
      state.spinning = false;
      renderMeters();
    }
  };

  // ----- events -----

  gameSelect.addEventListener('change', () => void loadGame(gameSelect.value));
  spinButton.addEventListener('click', () => void play());
  betDown.addEventListener('click', () => {
    state.betIndex = Math.max(0, state.betIndex - 1);
    renderMeters();
  });
  betUp.addEventListener('click', () => {
    state.betIndex = Math.min(bets().length - 1, state.betIndex + 1);
    renderMeters();
  });
  topUp.addEventListener('click', () => {
    state.balance = STARTING_BALANCE;
    renderMeters();
  });
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, button, summary, a')) return;
    event.preventDefault();
    void play();
  });

  const first = games.find((g) => g.id === 'fruits-96') ?? games[0];
  if (first) {
    gameSelect.value = first.id;
    void loadGame(first.id);
  } else {
    info.replaceChildren(h('p', { class: 'headline' }, 'No games yet. Add one with POST /games.'));
    renderMeters();
  }
}
