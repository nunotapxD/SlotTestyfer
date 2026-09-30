#!/usr/bin/env node
/**
 * Analysis from the command line. Writes a JSON report, a comparison CSV and, per game, the
 * sampled rounds and the session survival curve as CSV.
 *
 *   npm run analyze -- --game games/fruits-96.json --game games/fruits-88.json --seed 42
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseGameConfig } from '@slottestyfer/engine';
import { analyzeGame, compareGames, summarizeInWords } from './analysis.js';
import { analysisToJson, comparisonToCsv, roundsToCsv, survivalToCsv } from './export.js';
import { sampleRounds } from './sample.js';

const USAGE = `Usage: slottestyfer-analyze --game <file.json> [--game <file.json> ...] [options]

  --game <file>      game to analyse; repeat to compare several
  --rounds <n>       rounds kept for percentiles, streaks and drawdown (default 100000)
  --sessions <n>     player sessions (default 1000)
  --balance <n>      starting balance per session, in credits (default 100)
  --max-rounds <n>   round limit per session (default 1000)
  --seed <n>         seed (default 42)
  --out <dir>        output folder (default reports/analysis)`;

function main(): void {
  const { values } = parseArgs({
    options: {
      game: { type: 'string', multiple: true },
      rounds: { type: 'string' },
      sessions: { type: 'string' },
      balance: { type: 'string' },
      'max-rounds': { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.game?.length) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 3;
    return;
  }
  const num = (v: string | undefined, fallback: number) =>
    v === undefined ? fallback : Number(v.replaceAll('_', ''));
  const rounds = num(values.rounds, 100_000);
  const seed = num(values.seed, 42);
  const out = values.out ?? 'reports/analysis';
  mkdirSync(out, { recursive: true });

  const analyses = values.game.map((file) => {
    const config = parseGameConfig(JSON.parse(readFileSync(file, 'utf8')));
    process.stderr.write(`Analysing ${config.name}...\n`);
    const analysis = analyzeGame(config, {
      seed,
      rounds,
      sessions: num(values.sessions, 1000),
      balance: num(values.balance, 100),
      maxRounds: num(values['max-rounds'], 1000),
    });
    writeFileSync(
      join(out, `${config.id}-rounds.csv`),
      roundsToCsv(sampleRounds(config, rounds, seed)),
    );
    writeFileSync(join(out, `${config.id}-survival.csv`), survivalToCsv(analysis));
    return analysis;
  });

  writeFileSync(join(out, 'analysis.json'), analysisToJson(analyses));
  const rows = compareGames(analyses);
  writeFileSync(
    join(out, 'comparison.csv'),
    comparisonToCsv(
      analyses.map((a) => a.game),
      rows,
    ),
  );

  for (const analysis of analyses) {
    console.log(`\n${analysis.game.name}\n${'-'.repeat(analysis.game.name.length)}`);
    for (const line of summarizeInWords(analysis)) console.log(`- ${line}`);
  }
  if (analyses.length > 1) {
    console.log('\nComparison');
    const width = 26;
    console.log(`${''.padEnd(width)}${analyses.map((a) => a.game.id.padStart(14)).join('')}`);
    for (const row of rows) {
      const cells = row.values.map((v) => {
        if (typeof v === 'string') return v.padStart(14);
        if (row.unit === 'fraction') return `${(v * 100).toFixed(2)}%`.padStart(14);
        return (Number.isInteger(v) ? String(v) : v.toFixed(2)).padStart(14);
      });
      console.log(`${row.metric.padEnd(width)}${cells.join('')}`);
    }
  }
  console.log(`\nSaved analysis.json, comparison.csv and per-game CSVs in ${out}\n`);
}

main();
