import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_POLICY,
  EMPTY_STATE,
  closeWatch,
  evaluateWatch,
  mayStartLoop,
  mayStartProbe,
  openWatch,
  recordFailure,
  recordLoop,
  recordProbe,
  recordSuccess,
  recordTurn,
  tierAllowed,
  tierOf,
} from '../lib/policy.js'

const NOW = Date.UTC(2026, 9, 20, 3, 0, 0)
const metrics = (overrides = {}) => ({ failureRate: 0.1, meanSteps: 4, promptTokens: 1_000, ...overrides })

test('autonomy levels reach exactly their tier', () => {
  assert.equal(tierAllowed('off', 0), false)
  assert.equal(tierAllowed('memory', 0), true)
  assert.equal(tierAllowed('memory', 1), false)
  assert.equal(tierAllowed('skills', 1), true)
  assert.equal(tierAllowed('skills', 2), false)
  assert.equal(tierAllowed('full', 2), true)
  assert.equal(tierAllowed('full', 3), false)
})

test('a candidate is classified by what it can execute', () => {
  assert.equal(tierOf(true, [{ name: '@deepseek-ai/dsh-persona' }]), 3)
  assert.equal(tierOf(false, [{ name: '@deepseek-ai/dsh-skill-filesystem' }]), 1)
  assert.equal(tierOf(false, [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'x' } }]), 2)
  assert.equal(tierOf(false, []), 2)
})

test('a quiet loop starts, and the last loop is recorded', () => {
  assert.equal(mayStartLoop(EMPTY_STATE, DEFAULT_POLICY, NOW, 2).ok, false)
  const afterTurns = recordTurn({ ...EMPTY_STATE, lastLoopTurn: 0 }, 0)
  const state = { ...afterTurns, turns: 9 }
  assert.equal(mayStartLoop(state, DEFAULT_POLICY, NOW, 2).ok, true)
  const recorded = recordLoop(state, NOW, state.turns)
  assert.equal(mayStartLoop(recorded, DEFAULT_POLICY, NOW + 1_000, 2).ok, false)
})

test('the hour budget is a rolling window, not a counter', () => {
  let state = { ...EMPTY_STATE, turns: 100 }
  state = recordLoop(state, NOW, 100)
  state = recordLoop(state, NOW - 10_000, 100)
  const denied = mayStartLoop(state, DEFAULT_POLICY, NOW, 2)
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /loop budget spent \(2\/2/)

  // Two hours later the same entries are outside the window. Turns advanced too,
  // so this check isolates the rolling budget from the cooldown.
  assert.equal(mayStartLoop({ ...state, turns: 200 }, DEFAULT_POLICY, NOW + 2 * 3_600_000, 2).ok, true)
})

test('off and a lower autonomy level refuse by reason', () => {
  const state = { ...EMPTY_STATE, turns: 50 }
  assert.match(mayStartLoop(state, { ...DEFAULT_POLICY, autonomy: 'off' }, NOW, 2).reason, /autonomy is off/)
  assert.match(mayStartLoop(state, { ...DEFAULT_POLICY, autonomy: 'skills' }, NOW, 2).reason, /does not reach tier 2/)
  assert.equal(mayStartLoop(state, { ...DEFAULT_POLICY, autonomy: 'skills' }, NOW, 1).ok, true)
})

test('a full set of watch windows blocks the next loop, and one fewer does not', () => {
  let state = { ...EMPTY_STATE, turns: 50 }
  for (const id of ['c1', 'c2', 'c3']) {
    state = openWatch(state, { candidateId: id, appliedAtTurn: 50, baseline: metrics(), dueAtTurn: 62 })
  }
  assert.match(mayStartLoop(state, DEFAULT_POLICY, NOW, 2).reason, /already watching 3 changes \(c1 until turn 62, c2 until turn 62, c3 until turn 62\)/)
  assert.equal(mayStartLoop(state, { ...DEFAULT_POLICY, maxWatches: 4 }, NOW, 2).ok, true)
})

test('stacking drops the oldest window once the cap is reached', () => {
  let state = { ...EMPTY_STATE, turns: 50 }
  for (const id of ['c1', 'c2']) {
    state = openWatch(state, { candidateId: id, appliedAtTurn: 50, baseline: metrics(), dueAtTurn: 62 }, 2)
  }
  const names = () => (state.watches ?? []).map(watch => watch.candidateId)
  assert.deepEqual(names(), ['c1', 'c2'])
  state = openWatch(state, { candidateId: 'c3', appliedAtTurn: 50, baseline: metrics(), dueAtTurn: 62 }, 2)
  assert.deepEqual(names(), ['c2', 'c3'])
})

test('two internal failures park the loop', () => {
  let state = { ...EMPTY_STATE, turns: 50 }
  state = recordFailure(state)
  assert.equal(mayStartLoop(state, DEFAULT_POLICY, NOW, 2).ok, true)
  state = recordFailure(state)
  assert.match(mayStartLoop(state, DEFAULT_POLICY, NOW, 2).reason, /two internal failures/)
  assert.equal(mayStartLoop(recordSuccess(state), DEFAULT_POLICY, NOW, 2).ok, true)
})

test('two reverts park only composition changes', () => {
  let opened = { ...EMPTY_STATE, turns: 50 }
  opened = openWatch(opened, { candidateId: 'a', appliedAtTurn: 50, baseline: metrics(), dueAtTurn: 62 })
  opened = openWatch(opened, { candidateId: 'b', appliedAtTurn: 50, baseline: metrics(), dueAtTurn: 62 })
  const state = closeWatch(closeWatch(opened, 'a', true), 'b', true)
  assert.equal(state.revertsInARow, 2)
  assert.match(mayStartLoop(state, DEFAULT_POLICY, NOW, 2).reason, /two consecutive reverts/)
  assert.equal(mayStartLoop(state, DEFAULT_POLICY, NOW, 1).ok, true)
  assert.equal(mayStartLoop(closeWatch(state, 'a', false), DEFAULT_POLICY, NOW, 2).ok, true)
})

test('the probe budget is separate from the loop budget', () => {
  let state = { ...EMPTY_STATE, turns: 50 }
  assert.equal(mayStartProbe(state, DEFAULT_POLICY, NOW).ok, true)
  state = recordProbe(state, NOW)
  assert.match(mayStartProbe(state, DEFAULT_POLICY, NOW).reason, /probe budget spent/)
  assert.equal(mayStartProbe(state, DEFAULT_POLICY, NOW + 3_600_001).ok, true)
})

test('a failure rate rise beyond five points reverts', () => {
  const decision = evaluateWatch(metrics({ failureRate: 0.1 }), metrics({ failureRate: 0.16 }))
  assert.equal(decision.revert, true)
  assert.match(decision.reason, /failure rate rose from 10\.0% to 16\.0%/)
})

test('a small failure rise does not revert', () => {
  assert.equal(evaluateWatch(metrics({ failureRate: 0.1 }), metrics({ failureRate: 0.14 })).revert, false)
})

test('a step increase beyond a quarter reverts', () => {
  const decision = evaluateWatch(metrics({ meanSteps: 4 }), metrics({ meanSteps: 6 }))
  assert.equal(decision.revert, true)
  assert.match(decision.reason, /mean steps rose/)
  assert.equal(evaluateWatch(metrics({ meanSteps: 4 }), metrics({ meanSteps: 4.9 })).revert, false)
})

test('prompt growth beyond fifteen percent reverts', () => {
  const decision = evaluateWatch(metrics({ promptTokens: 1_000 }), metrics({ promptTokens: 1_200 }))
  assert.equal(decision.revert, true)
  assert.match(decision.reason, /prompt tokens rose/)
  assert.equal(evaluateWatch(metrics({ promptTokens: 1_000 }), metrics({ promptTokens: 1_100 })).revert, false)
})

test('a clean window closes without touching the revert counter', () => {
  const state = closeWatch({ ...EMPTY_STATE, watches: [{ candidateId: 'c', appliedAtTurn: 1, baseline: metrics(), dueAtTurn: 5, reverted: false }], revertsInARow: 1 }, 'c', false)
  assert.deepEqual(state.watches, [])
  assert.equal(state.revertsInARow, 0)
})
