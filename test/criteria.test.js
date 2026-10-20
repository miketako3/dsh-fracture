import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCriteriaPrompt, criteriaId, parseCriteria, renderCriteria } from '../lib/criteria.js'

const NOW = '2026-10-20T03:00:00.000Z'

test('an id is stable and filesystem safe', () => {
  assert.equal(criteriaId('Fix the Parser!'), 'fix-the-parser')
  assert.equal(criteriaId('  '), 'task-2')
  assert.match(criteriaId('日本語の依頼'), /^task-\d+$/)
})

test('the first command becomes the verify the probe runs', () => {
  const reply = JSON.stringify({
    checks: [
      { kind: 'check', text: 'the reply names the failing module', why: 'no command exists for this' },
      { kind: 'command', text: 'npm test', why: 'the suite covers it' },
    ],
  })
  const criteria = parseCriteria(reply, 'fix the parser', NOW)
  assert.equal(criteria.task, 'fix the parser')
  assert.equal(criteria.checks.length, 2)
  assert.equal(criteria.verify, 'npm test')
  assert.equal(criteria.refusal, undefined)
})

test('a refusal is kept as the answer instead of an invented check', () => {
  const criteria = parseCriteria('{"checks": [], "refusal": "the outcome is a taste decision"}', 'make it nicer', NOW)
  assert.deepEqual(criteria.checks, [])
  assert.equal(criteria.refusal, 'the outcome is a taste decision')
  assert.equal(criteria.verify, undefined)
  assert.match(renderCriteria(criteria), /cannot be made checkable/)
})

test('malformed checks are dropped and an empty set is refused', () => {
  assert.equal(parseCriteria('no json here', 'x', NOW), undefined)
  assert.equal(parseCriteria('{"checks": [{"kind": "vibes", "text": "x"}]}', 'x', NOW), undefined)
  assert.equal(parseCriteria('{"checks": [{"kind": "command"}]}', 'x', NOW), undefined)
})

test('at most five checks are kept', () => {
  const checks = Array.from({ length: 9 }, (_, index) => ({ kind: 'command', text: `step ${index}`, why: 'because' }))
  const criteria = parseCriteria(JSON.stringify({ checks }), 'x', NOW)
  assert.equal(criteria.checks.length, 5)
})

test('the prompt asks for refusal over invention', () => {
  const prompt = buildCriteriaPrompt('make the CLI nicer', ['bash fails with E_TOOL (3x)'])
  assert.match(prompt, /cannot be made checkable/)
  assert.match(prompt, /bash fails with E_TOOL \(3x\)/)
  assert.match(prompt, /Between two and five criteria/)
})
