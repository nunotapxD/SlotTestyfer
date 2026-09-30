#!/usr/bin/env node
/**
 * Command line simulator.
 *
 *   npm run simulate -- --game games/fruits-96.json --spins 10000000 --seed 42 --target 96
 *
 * Exit codes: 0 = PASS or no target given, 1 = FAIL, 2 = INCONCLUSIVE, 3 = bad input.
 * The exit code lets a CI pipeline block a release when a game does not pay what it should.
 */
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { GameConfigError, parseGameConfig, type GameConfig } from '@slottestyfer/engine';
import { analyzeExact } from './exact.js';
import { certify, summarize, type Report, type Verdict } from './report.js';
import { simulate } from './simulate.js';

const USAGE = `Usage: slottestyfer-simulate --game <file.json> [options]

  --game <file>        game configuration (required)
  --spins <n>          rounds to simulate (default 1000000; accepts 10_000_000 or 10e6)
  --seed <n>           seed, 0 to 4294967295 (default: random, printed in the report)
  --workers <n>        worker threads (default: number of CPU cores)
  --target <percent>   target RTP for the verdict, e.g. 96
  --tolerance <pp>     allowed deviation in percentage points (default 0.5)
  --exact              compute the exact RTP by playing every stop combination
  --json               print the report as JSON
  --out <file>         also save the JSON report to a file
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

function printReport(
  title: string,
  config: GameConfig,
  report: Report,
  details: string,
  verdict: Verdict | undefined,
): void {
  const rows: [string, string][] = [
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
  ];
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
  for (const [label, value] of rows) console.log(`${label.padEnd(15)}${value}`);

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

  if (verdict) {
    const range = `${pct(verdict.target)} ± ${pct(verdict.tolerance)}`;
    console.log(`\nVerdict        ${verdict.status}  target ${range}: ${verdict.reason}`);
    if (verdict.roundsNeeded !== undefined) {
      console.log(`               about ${int(verdict.roundsNeeded)} rounds should settle it`);
    }
  }
  console.log('');
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
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
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

  let report: Report;
  let details: string;
  let meta: Record<string, unknown>;
  const started = performance.now();

  if (values.exact) {
    const exact = analyzeExact(config);
    report = exact.report;
    const seconds = (performance.now() - started) / 1000;
    details = `every combination (${int(exact.combinations)}) in ${seconds.toFixed(2)} s`;
    meta = { mode: 'exact', combinations: exact.combinations, seconds };
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
  const output = { game: { id: config.id, name: config.name }, ...meta, report, verdict };

  if (values.out) writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
  if (values.json) console.log(JSON.stringify(output, null, 2));
  else printReport('SlotTestyfer', config, report, details, verdict);

  if (verdict?.status === 'FAIL') process.exitCode = 1;
  if (verdict?.status === 'INCONCLUSIVE') process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(3);
});
