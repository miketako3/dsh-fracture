import assert from 'node:assert/strict'
import test from 'node:test'
import {
  firstPromptTokens,
  firstPromptTokensFromHeadless,
  renderTrajectory,
  trajectoryFromHeadless,
  trajectoryFromSession,
} from '../lib/trajectory.js'

test('a session call and result pair into one action and observation', () => {
  const trajectory = trajectoryFromSession([
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"/a.md"}' } },
    { type: 'tool/result', data: { callId: 'c1', message: { isError: false, content: [{ type: 'text', text: 'hello' }] } } },
  ])
  assert.equal(trajectory.steps.length, 1)
  assert.match(trajectory.steps[0].action, /^read /)
  assert.match(trajectory.steps[0].action, /\/a\.md/)
  assert.equal(trajectory.steps[0].observation, 'hello')
  assert.equal(trajectory.toolErrors, 0)
})

test('a failed result is marked and counted', () => {
  const trajectory = trajectoryFromSession([
    { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"false"}' } },
    { type: 'tool/result', data: { callId: 'c1', message: { isError: true, content: [] }, error: { name: 'E', code: 'E' } } },
  ])
  assert.equal(trajectory.toolErrors, 1)
  assert.match(trajectory.steps[0].observation, /^\[error\]/)
})

test('a call without a result still appears', () => {
  const trajectory = trajectoryFromSession([{ type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } }])
  assert.equal(trajectory.steps[0].observation, '(no result recorded)')
})

test('the final assistant text is the last non-empty message', () => {
  const trajectory = trajectoryFromSession([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second' }] } } },
  ])
  assert.equal(trajectory.finalText, 'second')
})

test('the headless stream pairs by call id and takes the final answer', () => {
  const trajectory = trajectoryFromHeadless([
    { type: 'session', sessionId: 's', cwd: '/w' },
    { type: 'tool_call', callId: 'c1', tool: 'read', input: { path: '/a' } },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: 'body' },
    { type: 'text', text: 'partial' },
    { type: 'final', text: 'answer' },
  ])
  assert.equal(trajectory.steps.length, 1)
  assert.equal(trajectory.steps[0].observation, 'body')
  assert.equal(trajectory.finalText, 'answer')
})

test('a headless error result counts as a tool error', () => {
  const trajectory = trajectoryFromHeadless([
    { type: 'tool_call', callId: 'c1', tool: 'bash', input: { cmd: 'false' } },
    { type: 'tool_result', callId: 'c1', status: 'error', result: 'nope' },
  ])
  assert.equal(trajectory.toolErrors, 1)
  assert.match(trajectory.steps[0].observation, /^\[error\] nope$/)
})

test('long observations are clipped, not dropped', () => {
  const long = 'x'.repeat(5_000)
  const trajectory = trajectoryFromSession([
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { callId: 'c1', message: { isError: false, content: [{ type: 'text', text: long }] } } },
  ])
  assert.match(trajectory.steps[0].observation, /chars omitted\]$/)
})

test('the shared grammar starts each step with an action', () => {
  const rendered = renderTrajectory({ steps: [{ action: 'read x', observation: 'y' }], finalText: '', toolErrors: 0 })
  assert.equal(rendered, '[ACTION] read x\n[OBSERVATION]\ny')
  assert.equal(renderTrajectory({ steps: [], finalText: '', toolErrors: 0 }), '_(no tool activity)_')
})

test('the first step input tokens are read from the session log', () => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'assistant/message', data: { usage: { inputTokens: 4120, outputTokens: 90 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 5000, outputTokens: 10 } } },
  ]
  assert.equal(firstPromptTokens(events), 4120)
})

test('a first step without usage stays undefined rather than zero', () => {
  assert.equal(firstPromptTokens([{ type: 'assistant/message', data: {} }]), undefined)
  assert.equal(firstPromptTokens([]), undefined)
})

test('the headless stream reports the first step usage', () => {
  const events = [
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: 2300, outputTokens: 40 } },
    { type: 'status', phase: 'step_end', step: 2, usage: { inputTokens: 3100, outputTokens: 20 } },
  ]
  assert.equal(firstPromptTokensFromHeadless(events), 2300)
  assert.equal(firstPromptTokensFromHeadless([{ type: 'status', phase: 'step_end' }]), undefined)
})
