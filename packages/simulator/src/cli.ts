#!/usr/bin/env node
/**
 * Command line simulator.
 *
 *   npm run simulate -- --game games/fruits-96.json --spins 10000000 --seed 42 --target 96
 *   npm run simulate -- --game games/fruits-5x3.json --exact --target 96
 *
 * Exit codes: 0 = PASS or no target given, 1 = FAIL, 2 = INCONCLUSIVE, 3 = bad input.
 * The exit code lets a CI pipeline block a release when a game does not pay what it should.
 */
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { GameConfigError, parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { reportToCsv } from './csv.js';
import { analyzeExact } from './exact.js';
import { computeRtp, type RtpFormula } from './formula.js';
import { certify, certifyExact, summarize, type Report, type Verdict } from './report.js';
import { simulate } from './simulate.js';

const USAGE = `Usage: slottestyfer-simulate --game <file.json> [options]

  --game <file>        game configuration (required)
  --spins <n>          rounds to simulate (default 1000000; accepts 10_000_000 or 10e6)
  --seed <n>           seed, 0 to 4294967295 (default: random, printed in the report)
  --workers <n>        worker threads (default: number of CPU cores)
  --target <percent>   target RTP for the verdict, e.g. 96
  --tolerance <pp>     allowed deviation in percentage points (default 0.5)
  --exact              exact RTP by formula, for any game size (no simulation)
  --enumerate          exact report by playing every stop combination (small games only)
  --json               print the report as JSON
  --out <file>         also save the JSON report to a file
  --csv <file>         also save the report as CSV
  --help               show this help`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(3);
}

function parseNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replaceAll('_', ''));
  if (!Number.isFinite(parsed)) fail(`--${name} must be a number, got "${value}"`);
  return parsed;
}

function parseInteger(name: string, value: string | undefined): number | undefined {
  const parsed = parseNumber(name, value);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    fail(`--${name} must be a whole number, got "${value}"`);
  }
  return parsed;
}

const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`;
const int = (x: number) => x.toLocaleString('en-US');

function header(title: string, rows: [string, string][]): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
  for (const [label, value] of rows) console.log(`${label.padEnd(15)}${value}`);
}

function printVerdict(verdict: Verdict | undefined): void {
  if (!verdict) return;
  const range = `${pct(verdict.target)} ± ${pct(verdict.tolerance)}`;
  console.log(`\nVerdict        ${verdict.status}  target ${range}: ${verdict.reason}`);
  if (verdict.roundsNeeded !== undefined) {
    console.log(`               about ${int(verdict.roundsNeeded)} rounds should settle it`);
  }
}

function printReport(
  config: GameConfig,
  report: Report,
  details: string,
  verdict: Verdict | undefined,
): void {
  header('SlotTestyfer', [
    ['Game', `${config.name} (${config.id})`],
    ['Run', details],
    [
      'RTP',
      report.standardError > 0
        ? `${pct(report.rtp, 3)} ± ${pct(report.rtp - report.interval.low, 3)}  ` +
          `(95% CI ${pct(report.interval.low, 3)} to ${pct(report.interval.high, 3)})`
        : `${pct(report.rtp, 4)} (exact)`,
    ],
    ['Hit frequency', pct(report.hitFrequency)],
    ['Max win', `${report.maxWin}x total bet`],
    ['Volatility', `${report.stdDev.toFixed(3)} (std dev per round, in total bets)`],
    ...(config.freeSpins
      ? ([
          [
            'Free spins',
            `${pct(report.featureFrequency, 3)} of rounds (1 in ${int(Math.round(1 / (report.featureFrequency || Infinity)))})`,
          ],
        ] as [string, string][])
      : []),
  ]);

  const f = report.rtpByFeature;
  console.log('\nRTP by feature');
  console.log(`  ${'Lines'.padEnd(12)} ${pct(f.lines, 3).padStart(9)}`);
  console.log(`  ${'Scatters'.padEnd(12)} ${pct(f.scatters, 3).padStart(9)}`);
  if (config.freeSpins)
    console.log(`  ${'Free spins'.padEnd(12)} ${pct(f.freeSpins, 3).padStart(9)}`);
  console.log(`  ${'(with wilds)'.padEnd(12)} ${pct(f.wildAssisted, 3).padStart(9)}`);

  console.log('\nRTP by symbol');
  for (const { symbol, rtp } of report.rtpBySymbol) {
    console.log(`  ${symbol.padEnd(12)} ${pct(rtp, 3).padStart(9)}`);
  }

  console.log('\nWin distribution (x total bet)');
  const widest = Math.max(...report.histogram.map((b) => b.share));
  for (const bucket of report.histogram) {
    const bar = '#'.repeat(widest > 0 ? Math.round((bucket.share / widest) * 30) : 0);
    console.log(`  ${bucket.label.padEnd(6)} ${pct(bucket.share).padStart(8)}  ${bar}`);
  }
  printVerdict(verdict);
  console.log('');
}

function printFormula(config: GameConfig, formula: RtpFormula, verdict: Verdict | undefined): void {
  header('SlotTestyfer', [
    ['Game', `${config.name} (${config.id})`],
    ['Run', 'exact RTP by formula (no simulation)'],
    ['RTP', `${pct(formula.rtp, 4)} (exact)`],
    ['  lines', pct(formula.lines, 4)],
    ['  scatters', pct(formula.scatters, 4)],
    ...(config.freeSpins
      ? ([
          ['  free spins', pct(formula.freeSpins, 4)],
          [
            'Free spins',
            `trigger ${pct(formula.triggerProbability, 4)} (1 in ${int(Math.round(1 / formula.triggerProbability))})`,
          ],
        ] as [string, string][])
      : []),
  ]);
  printVerdict(verdict);
  console.log('\nHit frequency and volatility need a simulation (drop --exact).\n');
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        game: { type: 'string' },
        spins: { type: 'string' },
        seed: { type: 'string' },
        workers: { type: 'string' },
        target: { type: 'string' },
        tolerance: { type: 'string' },
        exact: { type: 'boolean', default: false },
        enumerate: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        csv: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.game) fail('--game is required');

  let config: GameConfig;
  try {
    config = parseGameConfig(JSON.parse(readFileSync(values.game, 'utf8')));
  } catch (error) {
    if (error instanceof GameConfigError) fail(`${values.game}\n${error.message}`);
    fail(`cannot read ${values.game}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const targetPercent = parseNumber('target', values.target);
  const tolerancePercent = parseNumber('tolerance', values.tolerance) ?? 0.5;
  const target = targetPercent === undefined ? undefined : targetPercent / 100;
  const tolerance = tolerancePercent / 100;
  const game = { id: config.id, name: config.name };

  if (values.exact) {
    const formula = computeRtp(config);
    const verdict = target === undefined ? undefined : certifyExact(formula.rtp, target, tolerance);
    const output = { game, mode: 'formula', formula, verdict };
    if (values.out) writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
    if (values.json) console.log(JSON.stringify(output, null, 2));
    else printFormula(config, formula, verdict);
    if (verdict?.status === 'FAIL') process.exitCode = 1;
    return;
  }

  let report: Report;
  let details: string;
  let meta: Record<string, string | number>;
  const started = performance.now();

  if (values.enumerate) {
    let exact;
    try {
      exact = analyzeExact(config);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    report = exact.report;
    const seconds = (performance.now() - started) / 1000;
    details = `every combination (${int(exact.combinations)}) in ${seconds.toFixed(2)} s`;
    meta = { mode: 'enumeration', combinations: exact.combinations, seconds };
  } else {
    const spins = parseInteger('spins', values.spins) ?? 1_000_000;
    const seed = parseInteger('seed', values.seed) ?? randomInt(0, 2 ** 32);
    const workers = parseInteger('workers', values.workers) ?? availableParallelism();
    if (spins < 1) fail('--spins must be at least 1');
    if (seed < 0 || seed >= 2 ** 32) fail('--seed must be between 0 and 4294967295');
    if (workers < 1) fail('--workers must be at least 1');

    const stats = await simulate(config, { spins, seed, workers });
    report = summarize(stats);
    const seconds = (performance.now() - started) / 1000;
    const rate = spins / seconds / 1e6;
    details =
      `${int(spins)} rounds, seed ${seed}, ${workers} worker${workers > 1 ? 's' : ''}, ` +
      `${seconds.toFixed(2)} s (${rate.toFixed(2)}M rounds/s)`;
    meta = { mode: 'simulation', spins, seed, workers, seconds };
  }

  const verdict = target === undefined ? undefined : certify(report, target, tolerance);
  const output = { game, ...meta, report, verdict };

  if (values.out) writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
  if (values.csv) {
    writeFileSync(values.csv, reportToCsv(report, verdict ?? null, { game: config.id, ...meta }));
  }
  if (values.json) console.log(JSON.stringify(output, null, 2));
  else printReport(config, report, details, verdict);

  if (verdict?.status === 'FAIL') process.exitCode = 1;
  if (verdict?.status === 'INCONCLUSIVE') process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(3);
});
