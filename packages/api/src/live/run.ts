/**
 * A live simulation: the game running continuously, with its numbers updated in batches.
 *
 * This file has no timers and no threads, so it is fully testable. The loop in loop.ts decides
 * how many rounds to play per tick (the speed) and runs this either in a worker thread or, in
 * tests, in the main thread.
 *
 * Besides the main stream of rounds (for RTP, confidence interval and verdict), a few virtual
 * players each start with 100 credits and play a handful of rounds per tick at human pace, so
 * the chart shows how different individual sessions look for the same game.
 */
import {
  createRng,
  createRoundEngine,
  deriveSeed,
  type GameConfig,
  type RoundEngine,
  type Rng,
} from '@slottestyfer/engine';
import {
  certify,
  emptyStats,
  recordRound,
  summarize,
  type SimStats,
  type VerdictStatus,
} from '@slottestyfer/simulator/core';

export interface LiveSettings {
  readonly seed: number;
  /** Target RTP as a fraction, e.g. 0.96. */
  readonly target: number;
  /** Allowed deviation as a fraction, e.g. 0.005. */
  readonly tolerance: number;
  /** Virtual players. */
  readonly players: number;
  /** Rounds each virtual player plays per tick. */
  readonly playerRoundsPerTick: number;
  /** Starting balance of each virtual player, in credits (bet 1 credit per round). */
  readonly startBalance: number;
  /** Rounds per second for the main stream; 0 = as fast as possible. */
  readonly roundsPerSecond: number;
  /** The run ends by itself after this many rounds. */
  readonly maxRounds: number;
}

export interface LivePlayer {
  readonly id: number;
  /** Balance in credits. */
  readonly balance: number;
  readonly rounds: number;
  /** Ran out of credits. */
  readonly busted: boolean;
}

export type LiveAlertKind = 'rtp-out-of-range' | 'rtp-back-in-range' | 'losing-streak';

export interface LiveAlert {
  readonly kind: LiveAlertKind;
  readonly rounds: number;
  readonly message: string;
}

export interface LiveVerdict {
  readonly status: VerdictStatus;
  /** PASS or FAIL: the confidence interval no longer crosses a limit of the allowed range. */
  readonly final: boolean;
}

export interface LiveBatch {
  /** Increases by 1 with every batch, so a client can check it misses nothing. */
  readonly seq: number;
  readonly rounds: number;
  readonly rtp: number;
  readonly low: number;
  readonly high: number;
  readonly hitFrequency: number;
  readonly maxWin: number;
  readonly stdDev: number;
  readonly featureFrequency: number;
  readonly longestLosingStreak: number;
  readonly verdict: LiveVerdict;
  readonly players: readonly LivePlayer[];
  /** Alerts raised since the previous batch. */
  readonly alerts: readonly LiveAlert[];
}

interface PlayerState {
  id: number;
  rng: Rng;
  /** In line bets, so balances stay exact. */
  balance: number;
  rounds: number;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/**
 * Losing streak that would be surprising in `rounds` rounds of a game with hit frequency h
 * (same reasoning as analytics' unusualStreakLength, repeated here to keep the API independent).
 */
export function streakAlarm(hitFrequency: number, rounds: number, alpha = 0.01): number {
  if (hitFrequency <= 0 || hitFrequency >= 1) return Infinity;
  const starts = Math.max(1, rounds) * hitFrequency;
  return Math.max(1, Math.ceil(Math.log(alpha / starts) / Math.log(1 - hitFrequency)));
}

export class LiveRun {
  readonly settings: LiveSettings;
  private readonly play: RoundEngine;
  private readonly rng: Rng;
  private readonly lines: number;
  private readonly stats: SimStats;
  private readonly players: PlayerState[];
  private seq = 0;
  private losing = 0;
  private longestLosing = 0;
  /** Longest streak we already raised an alert for. */
  private alertedStreak = 0;
  private lastStatus: VerdictStatus | null = null;
  private pendingAlerts: LiveAlert[] = [];

  constructor(config: GameConfig, settings: LiveSettings) {
    this.settings = settings;
    this.play = createRoundEngine(config);
    this.rng = createRng(settings.seed);
    this.lines = config.paylines.length;
    this.stats = emptyStats(this.lines);
    this.players = Array.from({ length: settings.players }, (_, id) => ({
      id,
      // Streams far from the main one's derived seeds, so players never share rounds.
      rng: createRng(deriveSeed(settings.seed, 1_000_000 + id)),
      balance: settings.startBalance * this.lines,
      rounds: 0,
    }));
  }

  get rounds(): number {
    return this.stats.rounds;
  }

  get finished(): boolean {
    return this.stats.rounds >= this.settings.maxRounds;
  }

  /** Plays up to `count` rounds of the main stream (never past maxRounds). */
  playRounds(count: number): number {
    const n = Math.max(0, Math.min(count, this.settings.maxRounds - this.stats.rounds));
    for (let i = 0; i < n; i++) {
      const outcome = this.play(this.rng);
      recordRound(this.stats, outcome);
      if (outcome.winLineBets > 0) {
        this.losing = 0;
      } else {
        this.losing++;
        if (this.losing > this.longestLosing) this.longestLosing = this.losing;
      }
    }
    return n;
  }

  /** Every player who still has credits plays their rounds for this tick. */
  playPlayers(): void {
    for (const player of this.players) {
      for (let i = 0; i < this.settings.playerRoundsPerTick; i++) {
        if (player.balance < this.lines) break;
        player.balance += this.play(player.rng).winLineBets - this.lines;
        player.rounds++;
      }
    }
  }

  private checkAlerts(status: VerdictStatus, hitFrequency: number): void {
    const rounds = this.stats.rounds;
    if (status === 'FAIL' && this.lastStatus !== 'FAIL') {
      this.pendingAlerts.push({
        kind: 'rtp-out-of-range',
        rounds,
        message: `RTP is outside ${pct(this.settings.target)} ± ${pct(this.settings.tolerance)} with 95% confidence`,
      });
    }
    if (this.lastStatus === 'FAIL' && status !== 'FAIL') {
      this.pendingAlerts.push({
        kind: 'rtp-back-in-range',
        rounds,
        message: 'RTP is no longer clearly outside the allowed range',
      });
    }
    // Only judge streaks once there are enough rounds to know the hit frequency.
    const alarm = rounds >= 1000 ? streakAlarm(hitFrequency, rounds) : Infinity;
    if (this.longestLosing >= alarm && this.longestLosing > this.alertedStreak) {
      this.alertedStreak = this.longestLosing;
      this.pendingAlerts.push({
        kind: 'losing-streak',
        rounds,
        message: `${this.longestLosing} rounds in a row without a win (unusual from ${alarm} in ${rounds.toLocaleString('en-US')} rounds)`,
      });
    }
    this.lastStatus = status;
  }

  /** The numbers so far, as one batch. Returns null before the first round. */
  batch(): LiveBatch | null {
    if (this.stats.rounds === 0) return null;
    const report = summarize(this.stats);
    const verdict = certify(report, this.settings.target, this.settings.tolerance);
    this.checkAlerts(verdict.status, report.hitFrequency);
    const alerts = this.pendingAlerts;
    this.pendingAlerts = [];
    this.seq += 1;
    return {
      seq: this.seq,
      rounds: report.rounds,
      rtp: report.rtp,
      low: report.interval.low,
      high: report.interval.high,
      hitFrequency: report.hitFrequency,
      maxWin: report.maxWin,
      stdDev: report.stdDev,
      featureFrequency: report.featureFrequency,
      longestLosingStreak: this.longestLosing,
      verdict: { status: verdict.status, final: verdict.status !== 'INCONCLUSIVE' },
      players: this.players.map((p) => ({
        id: p.id,
        balance: p.balance / this.lines,
        rounds: p.rounds,
        busted: p.balance < this.lines,
      })),
      alerts,
    };
  }
}
