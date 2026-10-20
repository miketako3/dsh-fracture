import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Autopilot } from '../lib/autopilot.js'
import { Store } from '../lib/store.js'
import { readDigest, readJournal, readObservations } from '../lib/memory.js'
import { listSkills } from '../lib/skills.js'

const NOW = Date.UTC(2026, 9, 20, 3, 0, 0)

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'fracture-auto-'))
  const store = new Store(root)
  await store.ensure()
  return { root, store }
}

function turn({ turn, task = 'do the thing', calls = ['read', 'edit'], failed = false, correction } = {}) {
  const base = NOW + turn * 1_000
  const events = [
    { type: 'turn/start', time: base, data: { turn } },
    { type: 'user/message', time: base + 1, data: { content: [{ type: 'text', text: task }] } },
  ]
  calls.forEach((name, at) => {
    events.push({ type: 'tool/call', time: base + 2 + at, data: { callId: `c${String(at)}`, name } })
    events.push({
      type: 'tool/result',
      time: base + 3 + at,
      data: {
        callId: `c${String(at)}`,
        message: { isError: failed && at === calls.length - 1, content: [] },
        ...(failed && at === calls.length - 1 ? { error: { code: 'E_TOOL' } } : {}),
      },
    })
  })
  events.push({ type: 'assistant/message', time: base + 20, data: { usage: { inputTokens: 10, outputTokens: 2 } } })
  if (correction !== undefined) {
    events.push({ type: 'user/message', time: base + 30, data: { content: [{ type: 'text', text: correction }] } })
  }
  events.push({ type: 'step/end', time: base + 40, data: { turn, step: 1 } })
  events.push({ type: 'turn/end', time: base + 50, data: { turn, reason: 'completed' } })
  return events
}

test('a closed turn is observed and appended', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, {}, () => NOW)
    const result = await pilot.observe('s1', turn({ turn: 1 }))
    assert.equal(result.observations, 1)
    const stored = await readObservations(store, 10)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].task, 'do the thing')
    assert.equal(pilot.index.observations, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an open turn is not observed', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, {}, () => NOW)
    const events = turn({ turn: 1 }).slice(0, -1)
    const result = await pilot.observe('s1', events)
    assert.equal(result.observations, 0)
    assert.deepEqual(await readObservations(store, 10), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('re-delivering the same events does not double count', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, {}, () => NOW)
    await pilot.observe('s1', turn({ turn: 1 }))
    await pilot.observe('s1', turn({ turn: 1 }))
    assert.equal((await readObservations(store, 10)).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('three clean turns distill one skill and write the digest', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, { digestEvery: 3 }, () => NOW)
    const written = []
    for (let at = 1; at <= 3; at += 1) {
      const result = await pilot.observe('s1', turn({ turn: at }))
      written.push(...result.skillsWritten)
    }
    assert.deepEqual(written, ['auto-read-edit'])
    const skills = await listSkills(store)
    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'auto-read-edit')
    assert.match(await readDigest(store), /## Procedures/)
    assert.match(pilot.index.digestHeadings.join(','), /Procedures/)
    assert.deepEqual([...pilot.index.skillNames], ['auto-read-edit'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing turn prevents a skill from being distilled', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, {}, () => NOW)
    for (let at = 1; at <= 3; at += 1) {
      await pilot.observe('s1', turn({ turn: at, failed: at === 2 }))
    }
    assert.deepEqual(await listSkills(store), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the digest waits for its interval', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, { digestEvery: 5 }, () => NOW)
    const first = await pilot.observe('s1', turn({ turn: 1 }))
    assert.equal(first.digested, false)
    await pilot.observe('s1', turn({ turn: 2 }))
    assert.equal(await readDigest(store), '')
    await pilot.observe('s1', turn({ turn: 3 }))
    await pilot.observe('s1', turn({ turn: 4 }))
    await pilot.observe('s1', turn({ turn: 5 }))
    assert.match(await readDigest(store), /from 5 observed turns/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('progress survives a restart', async () => {
  const { root, store } = await scratch()
  try {
    const first = new Autopilot(store, {}, () => NOW)
    await first.observe('s1', turn({ turn: 1 }))
    await first.observe('s1', turn({ turn: 2 }))

    const second = new Autopilot(store, {}, () => NOW)
    await second.load()
    assert.equal(second.index.observations, 2)
    const result = await second.observe('s1', turn({ turn: 3 }))
    assert.equal(result.observations, 1)
    assert.equal((await readObservations(store, 10)).length, 3)
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.equal(state.seen.s1, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the journal records what the loop did', async () => {
  const { root, store } = await scratch()
  try {
    const pilot = new Autopilot(store, { digestEvery: 1 }, () => NOW)
    await pilot.observe('s1', turn({ turn: 1 }))
    const lines = await readJournal(store, 10)
    assert.equal(lines.some(line => /memory digest rewritten/.test(line)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a corrupt state file starts from scratch instead of throwing', async () => {
  const { root, store } = await scratch()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'state.json'), '{not json', 'utf8')
    const pilot = new Autopilot(store, {}, () => NOW)
    await pilot.load()
    assert.equal(pilot.index.observations, 0)
    assert.equal(pilot.state.turns, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
