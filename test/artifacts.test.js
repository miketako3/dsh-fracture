import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeId, renderPatch } from '../lib/store.js'
import { candidateProblems, protectionOf } from '../lib/guard.js'
import { verdictOf } from '../lib/probe.js'

test('a patch layer renders as an insert list', () => {
  const patch = renderPatch([{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Be brief.' } }])
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^ {4}- id: persona$/m)
  assert.match(patch, /^ {6}name: @deepseek-ai\/dsh-persona$/m)
  assert.match(patch, /^ {6}config:$/m)
  assert.match(patch, /^ {8}prefix: Be brief\.$/m)
})

test('a multi-line config value becomes a block scalar indented under its key', () => {
  const patch = renderPatch([{ name: 'dsh-persona', config: { suffix: 'one\ntwo' } }])
  assert.match(patch, /^ {8}suffix: \|$/m)
  assert.match(patch, /^ {10}one$/m)
  assert.match(patch, /^ {10}two$/m)
})

test('a deep config value falls back to JSON flow so it stays valid YAML', () => {
  const patch = renderPatch([{ name: 'x', config: { deep: { nested: { a: 1 } } } }])
  assert.match(patch, /^ {6}config: \{"deep":\{"nested":\{"a":1\}\}\}$/m)
})

test('row names must be plain tokens', () => {
  assert.throws(() => renderPatch([{ name: 'a name' }]), /plain token/)
  assert.throws(() => renderPatch([{ id: 'a b', name: 'x' }]), /plain token/)
})

test('a config key that is not a plain identifier falls back to JSON', () => {
  const patch = renderPatch([{ name: 'x', config: { 'odd key': 1 } }])
  assert.match(patch, /^ {6}config: \{"odd key":1\}$/m)
})

test('ids that could escape the base directory are rejected', () => {
  assert.equal(assertSafeId('ok-id.1', 'id'), 'ok-id.1')
  for (const bad of ['../etc', 'a/b', '', 'A-B', '..']) {
    assert.throws(() => assertSafeId(bad, 'id'))
  }
})

test('the self-harness surface is protected', () => {
  for (const name of [
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-sandbox-policy',
    'dsh-plugin-manager',
    'dsh-self-harness',
  ]) {
    assert.notEqual(protectionOf({ name }), undefined, name)
  }
  assert.equal(protectionOf({ name: '@deepseek-ai/dsh-system-prompt' }), undefined)
})

test('an empty candidate and an oversized one are refused', () => {
  const base = { id: 'x', title: 't', rationale: 'r', finding: 'f', lever: 'prompt', rows: [] }
  assert.match(candidateProblems(base).join(' '), /no composition rows/)
  const many = { ...base, rows: Array.from({ length: 9 }, (_, index) => ({ name: `p${String(index)}` })) }
  assert.match(candidateProblems(many).join(' '), /inserts 9 rows/)
})

test('a run worth keeping is the only path to improved', () => {
  assert.equal(verdictOf(false, null, null).verdict, 'needs-review')
  assert.equal(verdictOf(true, false, true).verdict, 'improved')
  assert.equal(verdictOf(true, true, false).verdict, 'regressed')
  assert.equal(verdictOf(true, true, true).verdict, 'no-change')
  assert.equal(verdictOf(true, false, false).verdict, 'no-change')
  assert.equal(verdictOf(true, null, true).verdict, 'needs-review')
})
