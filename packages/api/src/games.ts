/**
 * Loads the bundled game files (games/*.json) into the store on startup.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import type { Store } from './store.js';

export function loadGameFiles(dir: string): GameConfig[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      try {
        return parseGameConfig(JSON.parse(readFileSync(path, 'utf8')));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${path}: ${reason}`, { cause: error });
      }
    });
}

/** Adds the games that are not in the store yet. Returns the ids that were added. */
export async function seedGames(store: Store, configs: readonly GameConfig[]): Promise<string[]> {
  const added: string[] = [];
  for (const config of configs) {
    if (!(await store.getGame(config.id))) {
      await store.addGame(config);
      added.push(config.id);
    }
  }
  return added;
}
