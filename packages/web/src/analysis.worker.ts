/**
 * Web Worker that runs a game analysis with the same engine the server uses, so the page stays
 * responsive while hundreds of thousands of rounds are played in the browser.
 */
import {
  analyzeGame,
  compareGames,
  summarizeInWords,
  type ComparisonRow,
  type GameAnalysis,
} from '@slottestyfer/analytics';
import { parseGameConfig } from '@slottestyfer/engine';

export interface AnalysisRequest {
  readonly configs: readonly unknown[];
  readonly rounds: number;
  readonly sessions: number;
  readonly maxRounds: number;
  readonly balance: number;
  readonly seed: number;
}

export type AnalysisMessage =
  | {
      readonly type: 'progress';
      readonly game: number;
      readonly games: number;
      readonly fraction: number;
      readonly stage: 'rounds' | 'sessions';
    }
  | {
      readonly type: 'done';
      readonly analyses: GameAnalysis[];
      readonly rows: ComparisonRow[];
      readonly words: string[][];
      readonly ms: number;
    }
  | { readonly type: 'error'; readonly message: string };

const post = (message: AnalysisMessage) =>
  (self as unknown as { postMessage(message: unknown): void }).postMessage(message);

self.addEventListener('message', (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  const started = performance.now();
  try {
    const games = request.configs.length;
    let lastPost = 0;
    const analyses = request.configs.map((raw, game) =>
      analyzeGame(parseGameConfig(raw), {
        seed: request.seed,
        rounds: request.rounds,
        sessions: request.sessions,
        maxRounds: request.maxRounds,
        balance: request.balance,
        onProgress: (fraction, stage) => {
          // At most ~20 progress messages a second.
          const now = performance.now();
          if (now - lastPost < 50 && fraction < 1) return;
          lastPost = now;
          post({ type: 'progress', game, games, fraction, stage });
        },
      }),
    );
    post({
      type: 'done',
      analyses,
      rows: compareGames(analyses),
      words: analyses.map(summarizeInWords),
      ms: performance.now() - started,
    });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
