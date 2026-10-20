import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_TASK_REPEATS, pickTask, shouldAutoLoop } from '../lib/autoloop.js'
import { DEFAULT_POLICY, EMPTY_STATE, closeWatch, openWatch, recordFailure, recordLoop } from '../lib/policy.js'

const NOW = Date.UTC(2026, 9, 20, 3, 0, 0)
const gate = (overrides = {}) => ({
  autonomy: 'full',
  policy: DEFAULT_POLICY,
  state: { ...EMPTY_STATE, turns: 20 },
  now: NOW,
  watching: false,
  ...overrides,
})

const observation = (task) => ({
  at: '2026-10-20T03:00:00.000Z', session: 's', turn: 1, task,
  tools: {}, sequence: [], failures: [], corrected: false, steps: 0, durationMs: 0,
})

test('a quiet full-autonomy loop may start', () => {
  assert.equal(shouldAutoLoop(gate()).ok, true)
})

test('memory and skills autonomy do not start a composition loop', () => {
  assert.match(shouldAutoLoop(gate({ autonomy: 'skills' })).reason, /does not reach composition changes/)
  assert.match(shouldAutoLoop(gate({ autonomy: 'memory' })).reason, /does not reach/)
  assert.match(shouldAutoLoop(gate({ autonomy: 'off' })).reason, /does not reach/)
})

test('a full watch set blocks a new loop', () => {
  assert.match(shouldAutoLoop(gate({ watching: true })).reason, /watch cap is reached/)
})

test('budget, cooldown, and failure counters all reach the gate', () => {
  assert.match(shouldAutoLoop(gate({ state: { ...EMPTY_STATE, turns: 20, loopStarts: [NOW - 1, NOW - 2] } })).reason, /loop budget spent/)
  assert.match(shouldAutoLoop(gate({ state: { ...EMPTY_STATE, turns: 3, lastLoopTurn: 0 } })).reason, /turns since the last loop/)
  assert.match(shouldAutoLoop(gate({ state: recordFailure(recordFailure({ ...EMPTY_STATE, turns: 20 })) })).reason, /two internal failures/)
})

test('two reverts park the loop until a clean window', () => {
  const parked = closeWatch(closeWatch({ ...EMPTY_STATE, turns: 20 }, 'a', true), 'b', true)
  assert.match(shouldAutoLoop(gate({ state: parked })).reason, /two consecutive reverts/)
})

test('a single recent loop keeps the next one waiting', () => {
  const state = recordLoop({ ...EMPTY_STATE, turns: 20 }, NOW - 1_000, 15)
  assert.equal(shouldAutoLoop(gate({ state })).ok, false)
})

test('a full set of windows in state blocks even when the caller forgets the flag', () => {
  let state = { ...EMPTY_STATE, turns: 20 }
  for (const id of ['a', 'b', 'c']) {
    state = openWatch(state, {
      candidateId: id, appliedAtTurn: 20, appliedAtIso: '2026-10-20T03:00:00.000Z',
      baseline: { failureRate: 0, meanSteps: 1, promptTokens: 10 }, dueAtTurn: 32,
    })
  }
  // The stored windows are authoritative, so a caller that forgets the flag still
  // cannot start another loop on top of unjudged changes.
  assert.match(shouldAutoLoop(gate({ state })).reason, /already watching 3 changes/)

  // One window open is not a reason to stop: stacking is the point.
  const single = openWatch({ ...EMPTY_STATE, turns: 20 }, {
    candidateId: 'c', appliedAtTurn: 20, appliedAtIso: '2026-10-20T03:00:00.000Z',
    baseline: { failureRate: 0, meanSteps: 1, promptTokens: 10 }, dueAtTurn: 32,
  })
  assert.equal(shouldAutoLoop(gate({ state: single })).ok, true)
})

test('the most repeated task is chosen', () => {
  const observations = [observation('fix the parser'), observation('fix the parser'), observation('rename x')]
  assert.equal(pickTask(observations), 'fix the parser')
})

test('a task seen once is not enough evidence', () => {
  assert.equal(MIN_TASK_REPEATS, 2)
  assert.equal(pickTask([observation('one off'), observation('another')]), undefined)
  assert.equal(pickTask([]), undefined)
  assert.equal(pickTask([observation('  '), observation('')]), undefined)
})
