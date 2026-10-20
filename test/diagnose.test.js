import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnose } from '../lib/diagnose.js'

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const ok = callId => ({ type: 'tool/result', data: { callId, message: { isError: false, content: [{ type: 'text', text: 'ok' }] } } })
const fail = callId => ({ type: 'tool/result', data: { callId, message: { isError: true, content: [] }, error: { name: 'E', code: 'E' } } })

test('counts calls and failures per tool', () => {
  const diagnosis = diagnose([[call('1', 'bash', { cmd: 'ls' }), fail('1'), call('2', 'bash', { cmd: 'ls' }), fail('2'), call('3', 'read', { path: '/a' }), ok('3')]])
  const bash = diagnosis.toolStats.find(stat => stat.name === 'bash')
  assert.equal(bash.calls, 2)
  assert.equal(bash.failures, 2)
  assert.equal(diagnosis.toolStats.find(stat => stat.name === 'read').failures, 0)
})

test('a failing tool above the ratio raises a high finding', () => {
  const diagnosis = diagnose([[
    call('1', 'bash', {}), fail('1'),
    call('2', 'bash', {}), fail('2'),
    call('3', 'bash', {}), ok('3'),
  ]])
  const finding = diagnosis.findings.find(item => item.id === 'tool-failures:bash')
  assert.ok(finding)
  assert.equal(finding.severity, 'high')
  assert.match(finding.evidence, /2 of 3 calls \(67%\)/)
})

test('a tool at the call floor is not judged', () => {
  const diagnosis = diagnose([[call('1', 'bash', {}), fail('1'), call('2', 'bash', {}), fail('2')]])
  assert.equal(diagnosis.findings.some(item => item.id.startsWith('tool-failures')), false)
})

test('repeated reads of one path raise a reread finding', () => {
  const diagnosis = diagnose([[
    call('1', 'read', { path: '/a/b.md' }), ok('1'),
    call('2', 'read', { path: '/a/b.md' }), ok('2'),
    call('3', 'read', { path: '/a/b.md' }), ok('3'),
  ]])
  const finding = diagnosis.findings.find(item => item.id === 'rereads')
  assert.ok(finding)
  assert.match(finding.evidence, /3 times/)
})

test('rejected approvals raise friction', () => {
  const diagnosis = diagnose([[
    { type: 'approval/decided', data: { id: 'a', outcome: 'rejected' } },
    { type: 'approval/decided', data: { id: 'b', outcome: 'rejected' } },
    { type: 'approval/decided', data: { id: 'c', outcome: 'allowed-once' } },
  ]])
  const finding = diagnosis.findings.find(item => item.id === 'approval-friction')
  assert.ok(finding)
  assert.match(finding.evidence, /2 operations/)
})

test('negative feedback outranks positive only when it repeats', () => {
  const single = diagnose([[{ type: 'feedback/message-put', data: { item: { rating: 'negative' } } }]])
  assert.equal(single.findings.some(item => item.id === 'negative-feedback'), false)
  const repeated = diagnose([[
    { type: 'feedback/message-put', data: { item: { rating: 'negative' } } },
    { type: 'feedback/message-put', data: { item: { rating: 'negative' } } },
  ]])
  assert.equal(repeated.findings.some(item => item.id === 'negative-feedback'), true)
  assert.equal(repeated.feedback.negative, 2)
})

test('token usage is summed from assistant messages', () => {
  const diagnosis = diagnose([[
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 7 } } },
  ]])
  assert.deepEqual(diagnosis.tokens, { input: 30, output: 12 })
})

test('tokens are null when the log carries no usage', () => {
  assert.equal(diagnose([[ok('x')]]).tokens, null)
})

test('compaction pressure needs two compactions', () => {
  const one = diagnose([[{ type: 'compaction/end', data: {} }]])
  assert.equal(one.findings.some(item => item.id === 'context-pressure'), false)
  const two = diagnose([[{ type: 'compaction/end', data: {} }, { type: 'compaction/end', data: {} }]])
  assert.equal(two.findings.some(item => item.id === 'context-pressure'), true)
})

test('findings are ranked high before low', () => {
  const diagnosis = diagnose([[
    call('1', 'read', { path: '/a' }), ok('1'),
    call('2', 'read', { path: '/a' }), ok('2'),
    call('3', 'read', { path: '/a' }), ok('3'),
    call('4', 'bash', {}), fail('4'),
    call('5', 'bash', {}), fail('5'),
    call('6', 'bash', {}), fail('6'),
  ]])
  assert.equal(diagnosis.findings[0].severity, 'high')
  assert.equal(diagnosis.findings.at(-1).severity, 'low')
})
