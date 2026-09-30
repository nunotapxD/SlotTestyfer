import './styles.css';
import { api, type GameSummary } from './api.js';
import { mountAnalyze } from './analyze.js';
import { byId, h, wait } from './dom.js';
import { mountGame } from './game.js';
import { mountLive } from './live.js';
import { mountSimulator } from './simulator.js';

const RETRY_MS = 3000;
const VIEWS = ['play', 'analyze', 'live'] as const;
type View = (typeof VIEWS)[number];

/** Shows one view, mounting it the first time it is opened. */
function router(games: readonly GameSummary[], showError: (message: string) => void): void {
  const mounted = new Set<View>();
  let stopLive: (() => void) | null = null;

  const show = () => {
    const wanted = location.hash.slice(1);
    const view: View = (VIEWS as readonly string[]).includes(wanted) ? (wanted as View) : 'play';
    for (const v of VIEWS) byId(`view-${v}`).hidden = v !== view;
    document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
      if (a.dataset['view'] === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (!mounted.has(view)) {
      mounted.add(view);
      if (view === 'play') {
        mountGame(byId('play'), games, showError);
        mountSimulator(byId('simulate'), games, showError);
      } else if (view === 'analyze') {
        mountAnalyze(byId('view-analyze'), games);
      } else {
        stopLive = mountLive(byId('view-live'), games);
      }
    }
  };
  window.addEventListener('hashchange', show);
  window.addEventListener('pagehide', () => stopLive?.());
  show();
}

async function start(): Promise<void> {
  const banner = byId('api-error');
  const showError = (message: string) => {
    banner.textContent = message;
    banner.hidden = false;
  };

  // Wait for the API: in Docker the page can load before the API container is ready.
  for (;;) {
    try {
      const games = await api.listGames();
      banner.hidden = true;
      router(games, showError);
      return;
    } catch (error) {
      showError(
        `${error instanceof Error ? error.message : String(error)} Retrying every ${RETRY_MS / 1000} s…`,
      );
      for (const id of ['play', 'simulate']) {
        byId(id).replaceChildren(h('p', { class: 'empty' }, 'Waiting for the API…'));
      }
      await wait(RETRY_MS);
    }
  }
}

void start();
