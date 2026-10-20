import assert from 'node:assert/strict'
import test from 'node:test'
import { SECTION_NAME, installLive, renderIndex } from '../lib/live.js'

const index = (overrides = {}) => ({ digestHeadings: [], skillNames: [], observations: 0, ...overrides })

/** A fake agent whose injected scopes can be driven by the test. */
function fakeAgent() {
  const scopes = []
  const injected = []
  const agent = {
    ctx: {
      inject(services, callback) {
        injected.push([...services])
        let disposed = false
        const scope = {
          systemPrompt: {
            sections: [],
            section(spec) {
              this.sections.push(spec)
              return () => { disposed = true }
            },
            getSectionOrder: () => 10_000,
          },
          skills: {
            registered: new Map(),
            register(skill) {
              this.registered.set(skill.name, skill)
              return () => { this.registered.delete(skill.name) }
            },
          },
        }
        scopes.push(scope)
        callback(scope)
        return { dispose: async () => { disposed = true } }
      },
    },
  }
  return { agent, scopes, injected }
}

const skill = (name) => ({ name, description: `${name} description`, content: '# body' })

test('an empty index renders nothing at all', () => {
  assert.equal(renderIndex(index()), '')
})

test('the index lists headings, skills, and counts, and stays bounded', () => {
  const text = renderIndex(index({
    digestHeadings: ['Parser work', 'Fixtures'],
    skillNames: Array.from({ length: 11 }, (_, at) => `skill-${String(at)}`),
    observations: 42,
  }))
  assert.match(text, /Parser work, Fixtures/)
  assert.match(text, /skill-0, skill-1/)
  assert.match(text, /\+3 more/)
  assert.match(text, /turns observed: 42/)
  assert.match(text, /memory_search/)
})

test('the section is named, ordered below the harness source, and not complete', () => {
  const { agent, scopes } = fakeAgent()
  const handle = installLive(agent, () => index({ observations: 1 }))
  const section = scopes[0].systemPrompt.sections[0]
  assert.equal(section.name, SECTION_NAME)
  assert.equal(section.order, 9_900)
  assert.equal(section.complete, undefined)
  assert.equal(section.interpolate, false)
  assert.match(section.text(), /turns observed: 1/)
  return handle.dispose()
})

test('the section body follows the store without re-registering', () => {
  const { agent, scopes } = fakeAgent()
  let current = index({ observations: 1 })
  const handle = installLive(agent, () => current)
  const section = scopes[0].systemPrompt.sections[0]
  assert.match(section.text(), /turns observed: 1/)
  current = index({ observations: 7, digestHeadings: ['Later'] })
  assert.match(section.text(), /turns observed: 7/)
  assert.match(section.text(), /Later/)
  assert.equal(scopes[0].systemPrompt.sections.length, 1)
  return handle.dispose()
})

test('a throwing index reads as an empty section rather than breaking the prompt', () => {
  const { agent, scopes } = fakeAgent()
  const handle = installLive(agent, () => { throw new Error('store is gone') })
  assert.equal(scopes[0].systemPrompt.sections[0].text(), '')
  return handle.dispose()
})

test('skills reconcile: additions register, removals dispose, unchanged stay', () => {
  const { agent, scopes } = fakeAgent()
  const handle = installLive(agent, () => index())
  const skills = scopes[1].skills

  handle.reconcile([skill('auto-a'), skill('auto-b')])
  assert.deepEqual([...skills.registered.keys()], ['auto-a', 'auto-b'])
  assert.equal(skills.registered.get('auto-a').source, 'runtime')

  handle.reconcile([skill('auto-b'), skill('auto-c')])
  assert.deepEqual([...skills.registered.keys()].sort(), ['auto-b', 'auto-c'])
  assert.equal(skills.registered.has('auto-a'), false)
})

test('a skill the registry rejects is skipped, not thrown', () => {
  const { agent, scopes } = fakeAgent()
  const handle = installLive(agent, () => index())
  const skills = scopes[1].skills
  skills.register = (candidate) => {
    if (candidate.name === 'Bad_Name') throw new Error('invalid skill name')
    skills.registered.set(candidate.name, candidate)
    return () => { skills.registered.delete(candidate.name) }
  }
  handle.reconcile([{ name: 'Bad_Name', description: 'x', content: 'y' }, skill('auto-ok')])
  assert.deepEqual([...skills.registered.keys()], ['auto-ok'])
})

test('dispose removes everything and later reconciles are inert', async () => {
  const { agent, scopes } = fakeAgent()
  const handle = installLive(agent, () => index())
  handle.reconcile([skill('auto-a')])
  await handle.dispose()
  handle.reconcile([skill('auto-b')])
  assert.equal(scopes[1].skills.registered.size, 1)
})

test('the prompt section is injected separately from skills', () => {
  const { agent, injected } = fakeAgent()
  const handle = installLive(agent, () => index())
  assert.deepEqual(injected, [['systemPrompt'], ['skills']])
  return handle.dispose()
})
