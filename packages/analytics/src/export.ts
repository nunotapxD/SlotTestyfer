/** Exporting analyses as JSON and CSV. Pure functions: the CLI writes the files. */
import type { ComparisonRow, GameAnalysis } from './analysis.js';
import type { RoundSample } from './sample.js';

function cell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const toCsv = (rows: readonly (readonly (string | number)[])[]): string =>
  `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`;

/** JSON of an analysis. Trajectories and survival curves are included; they are small. */
export function analysisToJson(analyses: readonly GameAnalysis[]): string {
  return `${JSON.stringify({ generatedBy: 'SlotTestyfer analytics', analyses }, null, 2)}\n`;
}

/** The comparison table: one row per metric, one column per game. */
export function comparisonToCsv(
  games: readonly { readonly id: string }[],
  rows: readonly ComparisonRow[],
): string {
  return toCsv([
    ['metric', 'unit', ...games.map((g) => g.id)],
    ...rows.map((r) => [r.metric, r.unit, ...r.values]),
  ]);
}

/** Every sampled round: round number, win in bets, whether it triggered free spins. */
export function roundsToCsv(sample: RoundSample): string {
  const rows: (string | number)[][] = [['round', 'win', 'free_spins']];
  for (let i = 0; i < sample.wins.length; i++) {
    rows.push([i + 1, sample.wins[i] ?? 0, sample.triggered[i] ?? 0]);
  }
  return toCsv(rows);
}

/** Share of players still playing after each round, one row per round. */
export function survivalToCsv(analysis: GameAnalysis): string {
  return toCsv([
    ['round', 'still_playing'],
    ...analysis.sessions.survival.map((share, i) => [i + 1, share]),
  ]);
}
