import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name } from '../lib/index.js'

/** A context stub exposing only what plugin mounting touches. */
function mount(baseDir, services = {}, config = {}) {
  const tools = []
  const handlers = new Map()
  const disposers = []
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    get: key => services[key],
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
    effect: (factory) => {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
  }
  apply(ctx, Config({ baseDir, ...config }))
  return { tools, handlers, disposers }
}

test('mounting registers the loop tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-mount-'))
  try {
    const { tools } = mount(root)
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      ['memory_search', 'self_adopt', 'self_diagnose', 'self_loop', 'self_probe', 'self_propose', 'self_status'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every tool ships a description, a schema, and a renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-shape-'))
  try {
    for (const tool of mount(root).tools) {
      assert.equal(typeof tool.description, 'string', tool.name)
      assert.ok(tool.description.length > 40, tool.name)
      assert.equal(typeof tool.parameters, 'object', tool.name)
      assert.deepEqual(tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }], tool.name)
      assert.equal(typeof tool.execute, 'function', tool.name)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the compiled parameter schema matches what the model will see', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-params-'))
  try {
    const probe = mount(root).tools.find(tool => tool.name === 'self_probe')
    assert.equal(probe.parameters.type, 'object')
    assert.deepEqual(probe.parameters.required, ['candidateId', 'task'])
    assert.equal(probe.parameters.properties.isolate.type, 'boolean')
    assert.equal(typeof probe.parameters.properties.isolate.description, 'string')

    const status = mount(root).tools.find(tool => tool.name === 'self_status')
    assert.deepEqual(status.parameters, { type: 'object', properties: {} })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the plugin declares a name and injects only the tools registry', () => {
  assert.equal(name, 'self-harness')
  assert.deepEqual(inject, ['tools'])
})

test('defaults resolve without a profile patch', () => {
  const config = Config({})
  assert.equal(config.baseDir, '.dsh/self-harness')
  assert.equal(config.provider, 'spawn')
  assert.equal(config.isolate, true)
  assert.equal(config.profilePatch, '')
  assert.equal(config.timeoutMs, 900_000)
})

test('self_status works on an empty base directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-status-'))
  try {
    const { tools } = mount(root)
    const status = tools.find(tool => tool.name === 'self_status')
    const text = await status.execute({}, { callId: 'c', rootCallId: 'c', name: 'self_status', arguments: {}, signal: new AbortController().signal })
    assert.match(text, /candidates: 0/)
    assert.match(text, /self_diagnose/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('self_diagnose without a session reader fails with an actionable message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-diag-'))
  try {
    const { tools } = mount(root)
    const diagnose = tools.find(tool => tool.name === 'self_diagnose')
    await assert.rejects(
      diagnose.execute({}, { callId: 'c', rootCallId: 'c', name: 'self_diagnose', arguments: {}, signal: new AbortController().signal }),
      /no session reader is installed/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('self_probe without a live agent refuses instead of guessing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-probe-'))
  try {
    const { tools } = mount(root)
    const probe = tools.find(tool => tool.name === 'self_probe')
    await assert.rejects(
      probe.execute(
        { candidateId: 'x', task: 't' },
        { callId: 'c', rootCallId: 'c', name: 'self_probe', arguments: {}, signal: new AbortController().signal },
      ),
      /needs a live agent/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memory_search on an empty store says so instead of inventing hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-search-'))
  try {
    const { tools } = mount(root)
    const search = tools.find(tool => tool.name === 'memory_search')
    const text = await search.execute({ query: 'parser' }, { callId: 'c', rootCallId: 'c', name: 'memory_search', arguments: {}, signal: new AbortController().signal })
    assert.match(text, /Nothing in memory matched/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('autonomy off leaves the session unwired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-off-'))
  try {
    const { handlers, disposers } = mount(root, {}, { autonomy: 'off' })
    assert.equal(handlers.size, 0)
    assert.equal(disposers.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the loop subscribes to sessions and agents by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-wired-'))
  try {
    const { handlers, disposers } = mount(root)
    assert.equal(handlers.has('session/event'), true)
    assert.equal(handlers.has('agent/created'), true)
    assert.equal(handlers.has('agent/disposed'), true)
    assert.equal(disposers.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('self_status reports autonomy and what was observed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-status2-'))
  try {
    const { tools } = mount(root)
    const status = tools.find(tool => tool.name === 'self_status')
    const text = await status.execute({}, { callId: 'c', rootCallId: 'c', name: 'self_status', arguments: {}, signal: new AbortController().signal })
    assert.match(text, /autonomy: `full`/)
    assert.match(text, /turns observed: 0/)
    assert.match(text, /distilled skills: 0/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
