/**
 * Metrics: the numbers a watch window compares.
 *
 * Deliberately three values. A window that watches ten signals will find
 * something to panic about every time, and a revert based on noise is worse
 * than leaving a mediocre change in place.
 */

import type { Observation } from './observe.js'
import type { Metrics } from './policy.js'

/**
 * Reduce observations to the three watched metrics.
 * @param observations - turns, oldest or newest first; ordering is irrelevant.
 * @param promptTokenFallback - value to use when the log carries no usage.
 * @returns failure rate over tool calls, mean steps per turn, mean prompt tokens.
 */
export function metricsFrom(observations: readonly Observation[], promptTokenFallback = 0): Metrics {
  if (observations.length === 0) return { failureRate: 0, meanSteps: 0, promptTokens: promptTokenFallback }

  let calls = 0
  let failures = 0
  let steps = 0
  let promptTokens = 0
  let withUsage = 0

  for (const observation of observations) {
    for (const count of Object.values(observation.tools)) calls += count
    failures += observation.failures.length
    steps += observation.steps
    if (observation.promptTokens !== undefined) {
      promptTokens += observation.promptTokens
      withUsage += 1
    }
  }

  return {
    failureRate: calls === 0 ? 0 : failures / calls,
    meanSteps: Math.round((steps / observations.length) * 100) / 100,
    promptTokens: withUsage === 0 ? promptTokenFallback : Math.round(promptTokens / withUsage),
  }
}

/**
 * Compare two windows of observations.
 * @param before - turns immediately before a change.
 * @param after - turns since the change.
 * @param promptTokenFallback - used when neither window recorded usage.
 * @returns the pair, ready for `evaluateWatch`.
 */
export function windowPair(
  before: readonly Observation[],
  after: readonly Observation[],
  promptTokenFallback = 0,
): { baseline: Metrics; current: Metrics } {
  return {
    baseline: metricsFrom(before, promptTokenFallback),
    current: metricsFrom(after, promptTokenFallback),
  }
}
