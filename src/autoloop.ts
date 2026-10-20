/**
 * The autonomous trigger: when may the loop start itself, and what should it
 * work on.
 *
 * Pure decisions only. Starting a loop costs three rollouts, so the gate has to
 * be inspectable and testable without a host, which is what this module is.
 */

import type { Observation } from './observe.js'
import { mayStartLoop, tierAllowed } from './policy.js'
import type { Autonomy, Decision, LoopState, PolicyConfig } from './policy.js'

/** Everything the gate looks at. */
export interface LoopGate {
  readonly autonomy: Autonomy
  readonly policy: PolicyConfig
  readonly state: LoopState
  readonly now: number
  /** Whether the open watch windows have reached the cap; at the cap a new loop waits. */
  readonly watching: boolean
}

/**
 * Decide whether the idle trigger may run a full loop now.
 * @param gate - autonomy, policy, state, clock, and the watch flag.
 * @returns a decision with a reason suitable for the journal.
 */
export function shouldAutoLoop(gate: LoopGate): Decision {
  if (!tierAllowed(gate.autonomy, 2)) {
    return { ok: false, reason: `autonomy "${gate.autonomy}" does not reach composition changes` }
  }
  if (gate.watching) return { ok: false, reason: 'the watch cap is reached' }
  return mayStartLoop(gate.state, gate.policy, gate.now, 2)
}

/** How much evidence a task needs before it is worth a loop. */
export const MIN_TASK_REPEATS = 2

/**
 * Pick the task the loop should improve the harness for.
 *
 * The most repeated task is the one the harness has the most evidence about, so
 * a change that helps it is the change with the largest expected payoff.
 * @param observations - recent turns.
 * @returns the task text, or undefined when nothing repeats enough.
 */
export function pickTask(observations: readonly Observation[]): string | undefined {
  const counts = new Map<string, number>()
  for (const observation of observations) {
    const task = observation.task.trim()
    if (task === '') continue
    counts.set(task, (counts.get(task) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1])
  const best = ranked[0]
  if (best === undefined || best[1] < MIN_TASK_REPEATS) return undefined
  return best[0]
}
