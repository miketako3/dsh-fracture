import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Autopilot } from '../lib/autopilot.js'
import { applyability, applyOverride, overrideOf, revertOverride, sectionNameFor } from '../lib/apply.js'
import { metricsFrom, windowPair } from '../lib/metrics.js'
import { Store } from '../lib/store.js'

const candidate = (overrides = {}) => ({
  id: 'cand-1',
  title: 't',
  rationale: 'r',
  finding: 'f',
  lever: 'prompt',
  rows: [],
  ...overrides,
})

const observation = (overrides = {}) => ({
  at: '2026-10-20T03:00:00.000Z',
  session: 's1',
  turn: 1,
  task: 'task',
  tools: { read: 1, edit: 1 },
  sequence: ['read', 'edit'],
  failures: [],
  corrected: false,
  steps: 2,
  durationMs: 10,
  promptTokens: 100,
  outputTokens: 10,
  ...overrides,
})

test('only a prompt-only candidate can be applied live', () => {
  assert.deepEqual(applyability(candidate()), { ok: false, reason: 'the candidate has no `prompt` text, so it can only be installed as a bundle' })
  assert.equal(applyability(candidate({ prompt: 'be terse' })).ok, true)
  const withRows = applyability(candidate({ prompt: 'be terse', rows: [{ name: '@deepseek-ai/dsh-persona' }] }))
  assert.equal(withRows.ok, false)
  assert.match(withRows.reason, /rows that only the loader can apply/)
})

test('the override carries a unique, sanitized section name', () => {
  assert.equal(sectionNameFor('Cand_1!'), 'fracture:candidate:cand_1-')
  assert.equal(sectionNameFor('a/b'), 'fracture:candidate:a-b')
  const override = overrideOf(candidate({ prompt: '  use pnpm  ' }))
  assert.equal(override.text, '  use pnpm  ')
  assert.equal(override.order, 9_950)
  assert.equal(overrideOf(candidate()), undefined)
})

test('an applied override is a section that dispose removes', async () => {
  const sections = []
  const agent = {
    ctx: {
      inject(_services, callback) {
        let disposed = false
        const scope = {
          systemPrompt: {
            section(spec) { sections.push(spec); return () => { disposed = true } },
            getSectionOrder: () => 10_000,
          },
        }
        callback(scope)
        return { dispose: async () => { disposed = true } }
      },
    },
  }
  const applied = applyOverride(agent, overrideOf(candidate({ prompt: 'prefer pnpm' })))
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'fracture:candidate:cand-1')
  assert.equal(sections[0].text(), 'prefer pnpm')
  await revertOverride(applied)
  assert.equal(sections[0].complete, undefined)
})

test('metrics reduce a window to three numbers', () => {
  const metrics = metricsFrom([
    observation({ tools: { read: 2, edit: 2 }, failures: [{ tool: 'edit', code: 'E' }], steps: 4, promptTokens: 200 }),
    observation({ tools: { read: 1 }, failures: [], steps: 2, promptTokens: 100 }),
  ])
  assert.equal(metrics.failureRate, 1 / 5)
  assert.equal(metrics.meanSteps, 3)
  assert.equal(metrics.promptTokens, 150)
})

test('an empty or usage-less window does not divide by zero', () => {
  assert.deepEqual(metricsFrom([]), { failureRate: 0, meanSteps: 0, promptTokens: 0 })
  const noUsage = metricsFrom([observation({ promptTokens: undefined })], 777)
  assert.equal(noUsage.promptTokens, 777)
})

test('the window pair separates before and after', () => {
  const before = [observation({ failures: [] })]
  const after = [observation({ failures: [{ tool: 'edit', code: 'E' }] })]
  const pair = windowPair(before, after)
  assert.equal(pair.baseline.failureRate, 0)
  assert.equal(pair.current.failureRate, 0.5)
})

test('a watch opens, is judged, and can revert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fracture-watch-'))
  try {
    const store = new Store(root)
    await store.ensure()
    let clock = Date.UTC(2026, 9, 20, 3, 0, 0)
    const pilot = new Autopilot(store, { digestEvery: 1_000 }, () => clock)

    const watch = await pilot.openWatch('cand-1', { failureRate: 0, meanSteps: 2, promptTokens: 100 }, 2)
    assert.equal(watch.candidateId, 'cand-1')
    assert.equal(watch.dueAtTurn, watch.appliedAtTurn + 2)
    assert.equal(pilot.watch?.candidateId, 'cand-1')

    const events = (turn) => {
      clock += 1_000
      const base = clock
      return [
        { type: 'turn/start', time: base, data: { turn } },
        { type: 'user/message', time: base + 1, data: { content: [{ type: 'text', text: 'task' }] } },
        { type: 'tool/call', time: base + 2, data: { callId: 'c', name: 'edit' } },
        { type: 'tool/result', time: base + 3, data: { callId: 'c', message: { isError: true, content: [] }, error: { code: 'E_TOOL' } } },
        { type: 'assistant/message', time: base + 4, data: { usage: { inputTokens: 100, outputTokens: 5 } } },
        { type: 'step/end', time: base + 5, data: { turn, step: 1 } },
        { type: 'turn/end', time: base + 6, data: { turn, reason: 'completed' } },
      ]
    }

    const first = await pilot.observe('s1', events(1))
    assert.equal(first.watch, undefined)
    const second = await pilot.observe('s1', events(2))
    assert.equal(second.watch?.candidateId, 'cand-1')
    assert.equal(second.watch?.revert, true)
    assert.match(second.watch?.reason ?? '', /tool failure rate rose/)
    assert.equal(pilot.watch, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a clean watch closes without reverting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fracture-watch2-'))
  try {
    const store = new Store(root)
    await store.ensure()
    let clock = Date.UTC(2026, 9, 20, 3, 0, 0)
    const pilot = new Autopilot(store, { digestEvery: 1_000 }, () => clock)
    await pilot.openWatch('cand-2', { failureRate: 0, meanSteps: 2, promptTokens: 100 }, 1)

    clock += 1_000
    const base = clock
    const events = (turn) => [
      { type: 'turn/start', time: base, data: { turn } },
      { type: 'user/message', time: base + 1, data: { content: [{ type: 'text', text: 'task' }] } },
      { type: 'tool/call', time: base + 2, data: { callId: 'c', name: 'read' } },
      { type: 'tool/result', time: base + 3, data: { callId: 'c', message: { isError: false, content: [] } } },
      { type: 'assistant/message', time: base + 4, data: { usage: { inputTokens: 100, outputTokens: 5 } } },
      { type: 'step/end', time: base + 5, data: { turn, step: 1 } },
      { type: 'turn/end', time: base + 6, data: { turn, reason: 'completed' } },
    ]
    const result = await pilot.observe('s1', events(1))
    assert.equal(result.watch?.revert, false)
    assert.match(result.watch?.reason ?? '', /no metric crossed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the watch survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fracture-watch3-'))
  try {
    const store = new Store(root)
    await store.ensure()
    const first = new Autopilot(store, {}, () => Date.UTC(2026, 9, 20, 3, 0, 0))
    await first.openWatch('cand-3', { failureRate: 0, meanSteps: 2, promptTokens: 100 }, 5)

    const second = new Autopilot(store, {}, () => Date.UTC(2026, 9, 20, 3, 1, 0))
    await second.load()
    assert.equal(second.watch?.candidateId, 'cand-3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
