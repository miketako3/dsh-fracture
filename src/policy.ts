/**
 * Autonomy policy: what the loop may do without being asked, and when it must stop.
 *
 * Everything here is pure so the boundaries can be tested without a host. The
 * rules are intentionally boring: a budget, a cooldown, a tier gate, and a
 * regression window. Boring is the point — an autonomous component that is
 * interesting to reason about is one that is hard to trust.
 */

import type { PresetRow } from './types.js'

/** How much the loop may do on its own. */
export type Autonomy = 'off' | 'memory' | 'skills' | 'full'

/** Risk tier of a change; see docs/AUTONOMY.md. */
export type Tier = 0 | 1 | 2 | 3

/** Tuning for the budget and the watch window. */
export interface PolicyConfig {
  readonly autonomy: Autonomy
  /** Loops started per rolling hour. */
  readonly maxLoopsPerHour: number
  /** Probes started per rolling hour. */
  readonly maxProbesPerHour: number
  /** Turns that must pass after a loop before another may start. */
  readonly minTurnsBetweenLoops: number
  /** How long an applied change is watched before it is judged. */
  readonly watchTurns: number
}

/** Defaults chosen so an idle user sees at most a couple of loops an hour. */
export const DEFAULT_POLICY: PolicyConfig = {
  autonomy: 'full',
  maxLoopsPerHour: 2,
  maxProbesPerHour: 1,
  minTurnsBetweenLoops: 8,
  watchTurns: 12,
}

/** Metrics compared across a watch window. */
export interface Metrics {
  /** Failures per tool call, 0..1. */
  readonly failureRate: number
  readonly meanSteps: number
  readonly promptTokens: number
}

/** An applied change still inside its watch window. */
export interface Watch {
  readonly candidateId: string
  readonly appliedAtTurn: number
  /** ISO time the change went live, used to select the turns that followed it. */
  readonly appliedAtIso: string
  readonly baseline: Metrics
  readonly dueAtTurn: number
  /** A revert counts against the loop's own reliability. */
  readonly reverted: boolean
}

/** Persisted loop state; small enough to rewrite on every decision. */
export interface LoopState {
  /** Milliseconds of recent loop starts. */
  readonly loopStarts: readonly number[]
  /** Milliseconds of recent probe starts. */
  readonly probeStarts: readonly number[]
  readonly lastLoopTurn: number
  readonly turns: number
  /** Consecutive internal failures; a self-downgrade trigger. */
  readonly failuresInARow: number
  readonly watch?: Watch
  /** Consecutive reverts; two disable composition changes for the session. */
  readonly revertsInARow: number
}

/** A fresh state. */
export const EMPTY_STATE: LoopState = {
  loopStarts: [],
  probeStarts: [],
  lastLoopTurn: 0,
  turns: 0,
  failuresInARow: 0,
  revertsInARow: 0,
}

/** Why the loop is not allowed to run, or a positive decision. */
export type Decision = { readonly ok: true } | { readonly ok: false; readonly reason: string }

const ALLOW: Decision = { ok: true }

function hourAgo(now: number): number {
  return now - 3_600_000
}

/** Whether a tier is reachable at the configured autonomy. */
export function tierAllowed(autonomy: Autonomy, tier: Tier): boolean {
  switch (autonomy) {
    case 'off': return false
    case 'memory': return tier === 0
    case 'skills': return tier <= 1
    case 'full': return tier <= 2
  }
}

/**
 * Classify a candidate.
 * @param hasPlugin - whether the candidate directory ships a `plugin/` entry.
 * @param rows - composition rows the candidate would insert.
 * @returns 3 for code, 1 for skill-only rows, 2 otherwise.
 */
export function tierOf(hasPlugin: boolean, rows: readonly PresetRow[]): Tier {
  if (hasPlugin) return 3
  if (rows.length > 0 && rows.every(row => /skill/i.test(row.name))) return 1
  return 2
}

/**
 * Decide whether a loop may start now.
 * @param state - persisted loop state.
 * @param config - policy.
 * @param now - current epoch milliseconds.
 * @param tier - the highest tier the loop intends to reach.
 * @returns a decision with a reason the journal can record verbatim.
 */
export function mayStartLoop(state: LoopState, config: PolicyConfig, now: number, tier: Tier): Decision {
  if (config.autonomy === 'off') return { ok: false, reason: 'autonomy is off' }
  if (!tierAllowed(config.autonomy, tier)) return { ok: false, reason: `autonomy "${config.autonomy}" does not reach tier ${String(tier)}` }
  if (state.failuresInARow >= 2) return { ok: false, reason: 'two internal failures in a row; downgraded until a manual run succeeds' }
  if (state.watch !== undefined) return { ok: false, reason: `watching ${state.watch.candidateId} until turn ${String(state.watch.dueAtTurn)}` }
  if (tier >= 2 && state.revertsInARow >= 2) return { ok: false, reason: 'two consecutive reverts; composition changes are parked' }

  const loops = state.loopStarts.filter(at => at > hourAgo(now))
  if (loops.length >= config.maxLoopsPerHour) {
    return { ok: false, reason: `loop budget spent (${String(loops.length)}/${String(config.maxLoopsPerHour)} this hour)` }
  }
  if (state.turns - state.lastLoopTurn < config.minTurnsBetweenLoops) {
    return { ok: false, reason: `only ${String(state.turns - state.lastLoopTurn)} turns since the last loop` }
  }
  return ALLOW
}

/**
 * Decide whether a probe may start now.
 * @param state - persisted loop state.
 * @param config - policy.
 * @param now - current epoch milliseconds.
 * @returns a decision with a reason.
 */
export function mayStartProbe(state: LoopState, config: PolicyConfig, now: number): Decision {
  const probes = state.probeStarts.filter(at => at > hourAgo(now))
  if (probes.length >= config.maxProbesPerHour) {
    return { ok: false, reason: `probe budget spent (${String(probes.length)}/${String(config.maxProbesPerHour)} this hour)` }
  }
  return ALLOW
}

/** Thresholds for calling a change a regression. */
export const REGRESSION = {
  /** Absolute increase in failure rate that counts, as a fraction. */
  failureRate: 0.05,
  /** Relative increase in mean steps that counts. */
  steps: 0.25,
  /** Relative increase in prompt tokens that counts, for prompt-ish changes. */
  promptTokens: 0.15,
} as const

/**
 * Compare the window's numbers and decide whether to revert.
 * @param baseline - metrics recorded when the change was applied.
 * @param current - metrics at the end of the window.
 * @returns whether to revert, with a reason that names the metric.
 */
export function evaluateWatch(baseline: Metrics, current: Metrics): { revert: boolean; reason: string } {
  const failureDelta = current.failureRate - baseline.failureRate
  if (failureDelta > REGRESSION.failureRate) {
    return {
      revert: true,
      reason: `tool failure rate rose from ${percent(baseline.failureRate)} to ${percent(current.failureRate)}`,
    }
  }
  if (baseline.meanSteps > 0 && current.meanSteps > baseline.meanSteps * (1 + REGRESSION.steps)) {
    return {
      revert: true,
      reason: `mean steps rose from ${baseline.meanSteps.toFixed(1)} to ${current.meanSteps.toFixed(1)}`,
    }
  }
  if (baseline.promptTokens > 0 && current.promptTokens > baseline.promptTokens * (1 + REGRESSION.promptTokens)) {
    return {
      revert: true,
      reason: `prompt tokens rose from ${String(baseline.promptTokens)} to ${String(current.promptTokens)}`,
    }
  }
  return { revert: false, reason: 'no metric crossed its threshold' }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** Record a loop start, dropping entries older than the rolling hour. */
export function recordLoop(state: LoopState, now: number, turn: number): LoopState {
  return {
    ...state,
    loopStarts: [...state.loopStarts.filter(at => at > hourAgo(now)), now],
    lastLoopTurn: turn,
  }
}

/** Record a probe start. */
export function recordProbe(state: LoopState, now: number): LoopState {
  return { ...state, probeStarts: [...state.probeStarts.filter(at => at > hourAgo(now)), now] }
}

/** Open a watch window after an apply. */
export function openWatch(state: LoopState, watch: Omit<Watch, 'reverted'>): LoopState {
  return { ...state, watch: { ...watch, reverted: false } }
}

/** Close the window and fold the outcome into the reliability counters. */
export function closeWatch(state: LoopState, reverted: boolean): LoopState {
  const { watch: _closed, ...rest } = state
  return {
    ...rest,
    revertsInARow: reverted ? state.revertsInARow + 1 : 0,
    failuresInARow: 0,
  }
}

/** Count a turn so cooldowns can be measured in turns rather than seconds. */
export function recordTurn(state: LoopState): LoopState {
  return { ...state, turns: state.turns + 1 }
}

/** Count an internal failure; two in a row downgrade autonomy. */
export function recordFailure(state: LoopState): LoopState {
  return { ...state, failuresInARow: state.failuresInARow + 1 }
}

/** Clear the failure counter after a clean loop. */
export function recordSuccess(state: LoopState): LoopState {
  return { ...state, failuresInARow: 0 }
}
