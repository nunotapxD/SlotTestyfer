#!/usr/bin/env node
/**
 * RTP tuner from the command line: changes reel strips until the game pays the target.
 *
 *   npm run tune -- --game games/fruits-5x3.json --target 96 --out games/fruits-5x3-tuned.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseGameConfig } from '@slottestyfer/engine';
import { computeRtp } from './formula.js';
import { tuneRtp } from './tune.js';

const USAGE = `Usage: slottestyfer-tune --game <file.json> --target <percent> [options]

  --game <file>        game configuration (required)
  --target <percent>   target RTP, e.g. 96 (required)
  --tolerance <pp>     stop when this close, in percentage points (default 0.05)
  --max-steps <n>      most symbols to change (default 200)
  --out <file>         where to save the tuned game (default: print it)
  --id <id>            id for the tuned game (default: same as the input)`;

function main(): void {
  const { values } = parseArgs({
    options: {
      game: { type: 'string' },
      target: { type: 'string' },
      tolerance: { type: 'string' },
      'max-steps': { type: 'string' },
      out: { type: 'string' },
      id: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.game || !values.target) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 3;
    return;
  }

  const config = parseGameConfig(JSON.parse(readFileSync(values.game, 'utf8')));
  const target = Number(values.target) / 100;
  const tolerance = Number(values.tolerance ?? '0.05') / 100;
  const maxSteps = Number(values['max-steps'] ?? '200');
  if (!Number.isFinite(target) || !Number.isFinite(tolerance) || !Number.isInteger(maxSteps)) {
    console.error(`error: invalid number\n\n${USAGE}`);
    process.exitCode = 3;
    return;
  }

  const result = tuneRtp(config, { target, tolerance, maxSteps });
  const pct = (x: number) => `${(x * 100).toFixed(4)}%`;
  console.log(`RTP ${pct(result.startRtp)} -> ${pct(result.rtp)} in ${result.steps.length} steps`);
  for (const step of result.steps) {
    console.log(`  reel ${step.reel + 1}: ${step.from} -> ${step.to}  (${pct(step.rtp)})`);
  }
  if (!result.reached) {
    console.log(
      `Could not get within ±${(tolerance * 100).toFixed(2)} pp: one symbol change moves the RTP too much. ` +
        'Longer reel strips give finer steps.',
    );
  }

  const tuned = { ...result.config, ...(values.id ? { id: values.id } : {}) };
  const check = computeRtp(parseGameConfig(tuned));
  const json = `${JSON.stringify(tuned, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    console.log(`Saved ${values.out} (exact RTP ${pct(check.rtp)})`);
  } else {
    console.log(json);
  }
  process.exitCode = result.reached ? 0 : 1;
}

main();
