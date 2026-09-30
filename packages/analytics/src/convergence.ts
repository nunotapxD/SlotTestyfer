/**
 * How the RTP estimate settles as rounds accumulate: the running RTP and its 95% confidence
 * interval at log-spaced points, so the first few hundred rounds and the last million both show.
 */
import { Z_95 } from '@slottestyfer/simulator/core';

export interface ConvergencePoint {
  readonly rounds: number;
  readonly rtp: number;
  readonly low: number;
  readonly high: number;
}

export function convergence(
  wins: ArrayLike<number>,
  points = 60,
  firstRound = 100,
): ConvergencePoint[] {
  const n = wins.length;
  if (n === 0) return [];
  const start = Math.min(firstRound, n);
  const marks = new Set<number>();
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 1 : i / (points - 1);
    marks.add(Math.round(start * (n / start) ** t));
  }
  marks.add(n);

  const result: ConvergencePoint[] = [];
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const w = wins[i] ?? 0;
    sum += w;
    sumSquares += w * w;
    const count = i + 1;
    if (marks.has(count)) {
      const mean = sum / count;
      const variance =
        count > 1 ? Math.max(0, (sumSquares / count - mean * mean) * (count / (count - 1))) : 0;
      const margin = Z_95 * Math.sqrt(variance / count);
      result.push({ rounds: count, rtp: mean, low: mean - margin, high: mean + margin });
    }
  }
  return result;
}
