/**
 * Everything in the simulator that is pure computation (no Node.js APIs), so it can also run in a
 * browser: totals, reports, verdicts, the exact RTP (formula and enumeration) and the tuner.
 * The worker-thread simulation and the CLI live in index.ts.
 */
export {
  HISTOGRAM_EDGES,
  HISTOGRAM_LABELS,
  emptyStats,
  histogramBucket,
  mergeStats,
  recordRound,
  type SimStats,
} from './stats.js';
export {
  Z_95,
  certify,
  certifyExact,
  summarize,
  type Report,
  type Verdict,
  type VerdictStatus,
} from './report.js';
export { runChunk } from './chunk.js';
export {
  DEFAULT_MAX_COMBINATIONS,
  analyzeExact,
  countCombinations,
  type ExactResult,
} from './exact.js';
export {
  computeRtp,
  expectedLinePay,
  reelDistribution,
  symbolCountDistribution,
  type ReelDistribution,
  type RtpFormula,
} from './formula.js';
export { reportToCsv } from './csv.js';
export { tuneRtp, type TuneOptions, type TuneResult, type TuneStep } from './tune.js';
