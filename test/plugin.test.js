import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name } from '../lib/index.js'

/** A context stub exposing only what plugin mounting touches. */
function mount(baseDir, services = {}) {
  const registered = []
  const ctx = {
    tools: { register: tool => registered.push(tool) },
    get: key => services[key],
  }
  apply(ctx, Config({ baseDir }))
  return registered
}

test('mounting registers the five loop tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-mount-'))
  try {
    const registered = mount(root)
    assert.deepEqual(
      registered.map(tool => tool.name).sort(),
      ['self_adopt', 'self_diagnose', 'self_probe', 'self_propose', 'self_status'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every tool ships a description, a schema, and a renderer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'self-harness-shape-'))
  try {
    for (const tool of mount(root)) {
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
    const probe = mount(root).find(tool => tool.name === 'self_probe')
    assert.equal(probe.parameters.type, 'object')
    assert.deepEqual(probe.parameters.required, ['candidateId', 'task'])
    assert.equal(probe.parameters.properties.isolate.type, 'boolean')
    assert.equal(typeof probe.parameters.properties.isolate.description, 'string')

    const status = mount(root).find(tool => tool.name === 'self_status')
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
    const registered = mount(root)
    const status = registered.find(tool => tool.name === 'self_status')
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
    const registered = mount(root)
    const diagnose = registered.find(tool => tool.name === 'self_diagnose')
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
    const registered = mount(root)
    const probe = registered.find(tool => tool.name === 'self_probe')
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
