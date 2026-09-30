import './styles.css';
import { api } from './api.js';
import { byId, h, wait } from './dom.js';
import { mountGame } from './game.js';
import { mountSimulator } from './simulator.js';

const RETRY_MS = 3000;

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
      mountGame(byId('play'), games, showError);
      mountSimulator(byId('simulate'), games, showError);
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
