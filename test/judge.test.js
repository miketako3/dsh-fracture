import assert from 'node:assert/strict'
import test from 'node:test'
import { buildJudgePrompt, parseJudge, renderJudge } from '../lib/judge.js'

const side = (text) => ({ passed: null, trajectory: { steps: [{ action: 'read a.js', observation: 'ok' }], finalText: text, toolErrors: 0 } })

test('the prompt shows both runs without saying which is which', () => {
  const prompt = buildJudgePrompt('fix the parser', side('done'), side('stopped'))
  assert.match(prompt, /Run A/)
  assert.match(prompt, /Run B/)
  assert.match(prompt, /fix the parser/)
  // Neither heading is tied to a side: a judge that knows which run carries the
  // change scores the change, not the work.
  for (const line of prompt.split('\n')) {
    if (/^## Run [AB]$/.test(line)) continue
    assert.doesNotMatch(line, /Run [AB] (is|was|has) the (candidate|current)/)
  }
})

test('a score is read from a fenced reply with prose around it', () => {
  const parsed = parseJudge('Here you go:\n```json\n{"baseline": 2, "changed": 4, "reason": "A looped."}\n```\n')
  assert.deepEqual(parsed, { baseline: 2, changed: 4, verdict: 'improved', reason: 'A looped.' })
})

test('the verdict comes from the numbers, not from the prose', () => {
  const parsed = parseJudge('{"baseline": 4, "changed": 2, "reason": "this is much better"}')
  assert.equal(parsed.verdict, 'regressed')
})

test('an unusable reply is refused rather than guessed', () => {
  assert.equal(parseJudge('I cannot compare these.'), undefined)
  assert.equal(parseJudge('{"baseline": 9, "changed": 3}'), undefined)
  assert.equal(parseJudge('{"baseline": "high", "changed": 3}'), undefined)
})

test('the render names the scale and the reason', () => {
  const text = renderJudge({ score: { baseline: 3, changed: 4, verdict: 'improved', reason: 'B verified.' }, raw: '' })
  assert.match(text, /baseline \| 3\/5/)
  assert.match(text, /B verified\./)
  assert.match(renderJudge({ raw: '', error: 'no score' }), /did not produce a score/)
})
