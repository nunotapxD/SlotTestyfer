/**
 * Worker thread entry point for a live run: commands come in through the port, events go out.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseGameConfig } from '@slottestyfer/engine';
import { runLiveLoop, type LiveCommand } from './loop.js';
import type { LiveSettings } from './run.js';

const port = parentPort;
if (!port) throw new Error('live/worker.js must be started as a worker thread');

const data = workerData as { config: unknown; settings: LiveSettings };
const config = parseGameConfig(data.config);

void runLiveLoop(config, data.settings, {
  onCommand: (handler) => port.on('message', (command: LiveCommand) => handler(command)),
  emit: (event) => port.postMessage(event),
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}).then(() => port.close());
