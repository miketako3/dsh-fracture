import assert from 'node:assert/strict'
import test from 'node:test'
import { looksLikeCorrection, observationsFromSession, summarizeObservations } from '../lib/observe.js'

const T0 = Date.UTC(2026, 9, 20, 3, 0, 0)

function turnEvents({ turn = 1, task = 'add a test', usage = { inputTokens: 100, outputTokens: 20 }, calls = [['read', true], ['edit', true]], correction } = {}) {
  const events = [
    { type: 'turn/start', time: T0, data: { turn } },
    { type: 'user/message', time: T0 + 10, data: { content: [{ type: 'text', text: task }] } },
  ]
  let seq = 0
  for (const [name, ok] of calls) {
    seq += 1
    events.push({ type: 'tool/call', time: T0 + 20 + seq, data: { callId: `c${String(seq)}`, name, arguments: '{}' } })
    events.push({
      type: 'tool/result',
      time: T0 + 30 + seq,
      data: {
        callId: `c${String(seq)}`,
        message: { isError: ok !== true, content: [{ type: 'text', text: ok === true ? 'ok' : 'boom' }] },
        ...(ok === true ? {} : { error: { name: 'E', code: 'FILE_NOT_SEEN' } }),
      },
    })
  }
  events.push({ type: 'assistant/message', time: T0 + 200, data: { usage } })
  if (correction !== undefined) {
    events.push({ type: 'user/message', time: T0 + 300, data: { content: [{ type: 'text', text: correction }] } })
  }
  events.push({ type: 'step/end', time: T0 + 300, data: { turn, step: 1 } })
  events.push({ type: 'turn/end', time: T0 + 400, data: { turn, reason: 'completed' } })
  return events
}

test('one completed turn becomes one observation', () => {
  const observations = observationsFromSession('s1', turnEvents())
  assert.equal(observations.length, 1)
  const observation = observations[0]
  assert.equal(observation.session, 's1')
  assert.equal(observation.turn, 1)
  assert.equal(observation.task, 'add a test')
  assert.deepEqual(observation.tools, { read: 1, edit: 1 })
  assert.deepEqual(observation.sequence, ['read', 'edit'])
  assert.deepEqual(observation.failures, [])
  assert.equal(observation.steps, 1)
  assert.equal(observation.durationMs, 400)
  assert.equal(observation.promptTokens, 100)
  assert.equal(observation.outputTokens, 20)
})

test('a failed tool result records the tool and the error code', () => {
  const observation = observationsFromSession('s1', turnEvents({ calls: [['read', true], ['edit', false]] }))[0]
  assert.deepEqual(observation.failures, [{ tool: 'edit', code: 'FILE_NOT_SEEN' }])
})

test('consecutive repeats of the same tool collapse in the sequence', () => {
  const observation = observationsFromSession('s1', turnEvents({ calls: [['read', true], ['read', true], ['bash', true], ['bash', true]] }))[0]
  assert.deepEqual(observation.sequence, ['read', 'bash'])
  assert.equal(observation.tools.read, 2)
})

test('a corrective follow-up marks the turn', () => {
  const observation = observationsFromSession('s1', turnEvents({ correction: 'no, that is not what I meant' }))[0]
  assert.equal(observation.corrected, true)
})

test('correction detectors are conservative', () => {
  assert.equal(looksLikeCorrection('no, use pnpm'), true)
  assert.equal(looksLikeCorrection('違う、そこじゃない'), true)
  assert.equal(looksLikeCorrection('add a test for the parser'), false)
  assert.equal(looksLikeCorrection(''), false)
  assert.equal(looksLikeCorrection('x'.repeat(500)), false)
})

test('two turns produce two observations, each with its own task', () => {
  const first = turnEvents({ turn: 1, task: 'first' })
  const second = turnEvents({ turn: 2, task: 'second' })
  const observations = observationsFromSession('s1', [...first, ...second])
  assert.deepEqual(observations.map(item => item.task), ['first', 'second'])
  assert.deepEqual(observations.map(item => item.turn), [1, 2])
})

test('a turn without turn/end is still reported', () => {
  const events = [
    { type: 'turn/start', time: T0, data: { turn: 9 } },
    { type: 'user/message', time: T0 + 5, data: { content: [{ type: 'text', text: 'open' }] } },
  ]
  const observations = observationsFromSession('s1', events, T0 + 1_000)
  assert.equal(observations.length, 1)
  assert.equal(observations[0].task, 'open')
  // An open turn is measured to its last event, not to the current clock.
  assert.equal(observations[0].durationMs, 5)
})

test('unrecognized events are ignored rather than guessed at', () => {
  const events = [
    { type: 'turn/start', time: T0, data: { turn: 1 } },
    { type: 'plugin:something-new', time: T0 + 1, data: { anything: true } },
    { type: 'turn/end', time: T0 + 2, data: { turn: 1, reason: 'completed' } },
  ]
  const observations = observationsFromSession('s1', events)
  assert.equal(observations.length, 1)
  assert.deepEqual(observations[0].tools, {})
})

test('summary reports the aggregate shape without a model call', () => {
  const observations = [
    ...observationsFromSession('s1', turnEvents({ turn: 1, calls: [['read', true], ['bash', false]] })),
    ...observationsFromSession('s1', turnEvents({ turn: 2, calls: [['bash', true]], correction: '違う' })),
  ]
  const summary = summarizeObservations(observations)
  assert.equal(summary.turns, 2)
  assert.equal(summary.failures, 1)
  assert.equal(summary.corrections, 1)
  assert.equal(summary.topTool, 'bash')
  assert.equal(summarizeObservations([]).turns, 0)
})
