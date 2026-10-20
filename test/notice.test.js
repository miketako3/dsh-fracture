import assert from 'node:assert/strict'
import test from 'node:test'
import { noticeMessage, notify } from '../lib/notice.js'

test('a notice is producer-tagged context, not a user request', () => {
  const message = noticeMessage('applied candidate-1; watching 12 turns')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'self-harness')
  assert.equal(message.source.form, 'notice')
  assert.match(message.source.summary, /applied candidate-1/)
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /watching 12 turns/)
})

test('the summary is one line and bounded', () => {
  const message = noticeMessage('# Heading\n\nbody text', 'a'.repeat(400))
  assert.equal(message.source.summary.length <= 120, true)
  assert.equal(message.source.summary.includes('\n'), false)

  const firstLine = noticeMessage('# Heading\n\nbody text')
  assert.equal(firstLine.source.summary, '# Heading')
})

test('notify delivers through an injectable agent', () => {
  const injected = []
  assert.equal(notify({ inject: message => injected.push(message) }, 'hello'), true)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.kind, 'self-harness')
})

test('notify is silent when there is no agent or the agent refuses', () => {
  assert.equal(notify(undefined, 'hello'), false)
  assert.equal(notify({ inject: () => { throw new Error('idle') } }, 'hello'), false)
})
