/**
 * Worker thread entry point: receives chunks, runs them and sends the totals back.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseGameConfig } from '@slottestyfer/engine';
import { runChunk } from './chunk.js';
import type { ChunkDone, ChunkJob } from './simulate.js';

const port = parentPort;
if (!port) throw new Error('worker.js must be started as a worker thread');

const { config: rawConfig } = workerData as { config: unknown };
const config = parseGameConfig(rawConfig);

port.on('message', (job: ChunkJob) => {
  const done: ChunkDone = { index: job.index, stats: runChunk(config, job.rounds, job.seed) };
  port.postMessage(done);
});
