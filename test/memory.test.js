import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../lib/store.js'
import {
  appendObservations,
  countObservations,
  digestPath,
  journal,
  memoryIndex,
  observationsPath,
  readDigest,
  readJournal,
  readObservations,
  searchMemory,
  writeDigest,
} from '../lib/memory.js'
import { listSkills, renderSkill, skillCandidates, skillSlug, writeSkill } from '../lib/skills.js'

const observation = (overrides = {}) => ({
  at: '2026-10-20T03:00:00.000Z',
  session: 's1',
  turn: 1,
  task: 'add a test for the parser',
  tools: { read: 1, edit: 1 },
  sequence: ['read', 'edit'],
  failures: [],
  corrected: false,
  steps: 2,
  durationMs: 1_000,
  ...overrides,
})

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'fracture-memory-'))
  const store = new Store(root)
  await store.ensure()
  return { root, store }
}

test('observations append and read back in order', async () => {
  const { root, store } = await scratch()
  try {
    assert.equal(await appendObservations(store, [observation({ turn: 1 }), observation({ turn: 2 })]), 2)
    await appendObservations(store, [observation({ turn: 3 })])
    const all = await readObservations(store, 10)
    assert.deepEqual(all.map(item => item.turn), [1, 2, 3])
    assert.equal(await countObservations(store), 3)
    assert.deepEqual((await readObservations(store, 2)).map(item => item.turn), [2, 3])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a truncated tail line does not break the log', async () => {
  const { root, store } = await scratch()
  try {
    await appendObservations(store, [observation({ turn: 1 })])
    await appendFile(observationsPath(store), '{"turn": 2, "ses\n', 'utf8')
    const all = await readObservations(store, 10)
    assert.equal(all.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an absent log reads as empty', async () => {
  const { root, store } = await scratch()
  try {
    assert.deepEqual(await readObservations(store, 10), [])
    assert.equal(await readDigest(store), '')
    assert.deepEqual(await readJournal(store, 5), [])
    assert.deepEqual(await listSkills(store), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the digest is replaced, not appended', async () => {
  const { root, store } = await scratch()
  try {
    await writeDigest(store, '# Memory\n\n## Topic one\nbody')
    await writeDigest(store, '# Memory\n\n## Topic two\nbody')
    const text = await readDigest(store)
    assert.match(text, /Topic two/)
    assert.equal(text.includes('Topic one'), false)
    assert.equal(await readFile(digestPath(store), 'utf8'), text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search covers the digest and the observation log', async () => {
  const { root, store } = await scratch()
  try {
    await writeDigest(store, '## Parser work\nuse the fixture builder')
    await appendObservations(store, [
      observation({ task: 'add a test for the parser' }),
      observation({ task: 'rename the lexer module' }),
    ])
    const parser = await searchMemory(store, 'parser', 10)
    assert.equal(parser.length >= 2, true)
    assert.equal(parser.some(hit => hit.kind === 'digest'), true)
    assert.equal(parser.some(hit => hit.kind === 'observation'), true)

    const lexer = await searchMemory(store, 'lexer', 10)
    assert.equal(lexer.length, 1)
    assert.match(lexer[0].text, /rename the lexer module/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the index carries headings and names, not content', async () => {
  const { root, store } = await scratch()
  try {
    await writeDigest(store, '# Memory\n\n## Parser work\nlong body that must not leak\n\n### Fixtures\nmore')
    await appendObservations(store, [observation()])
    const index = await memoryIndex(store, [{ name: 'auto-read-edit' }])
    assert.deepEqual(index.digestHeadings, ['Parser work', 'Fixtures'])
    assert.deepEqual(index.skillNames, ['auto-read-edit'])
    assert.equal(index.observations, 1)
    assert.equal(JSON.stringify(index).includes('long body'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the journal appends one line per entry', async () => {
  const { root, store } = await scratch()
  try {
    await journal(store, 'applied candidate-1')
    await journal(store, 'reverted candidate-1')
    const lines = await readJournal(store, 5)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /applied candidate-1/)
    assert.match(lines[1], /reverted candidate-1/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('three clean repetitions of a two-step procedure become a candidate', () => {
  const observations = [1, 2, 3].map(turn => observation({ turn }))
  const candidates = skillCandidates(observations)
  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0].sequence, ['read', 'edit'])
  assert.equal(candidates[0].count, 3)
  assert.equal(candidates[0].slug, 'auto-read-edit')
})

test('two repetitions are not enough', () => {
  assert.deepEqual(skillCandidates([observation({ turn: 1 }), observation({ turn: 2 })]), [])
})

test('a failure or a correction disqualifies the repetition', () => {
  const failing = [1, 2, 3].map(turn => observation({ turn, failures: turn === 1 ? [{ tool: 'edit', code: 'E' }] : [] }))
  assert.deepEqual(skillCandidates(failing), [])
  const corrected = [1, 2, 3].map(turn => observation({ turn, corrected: turn === 2 }))
  assert.deepEqual(skillCandidates(corrected), [])
})

test('a single-tool procedure is left to the tool description', () => {
  const observations = [1, 2, 3].map(turn => observation({ turn, sequence: ['bash'], tools: { bash: 1 } }))
  assert.deepEqual(skillCandidates(observations), [])
})

test('the slug is filesystem safe and bounded', () => {
  assert.equal(skillSlug(['read', 'edit', 'bash']), 'auto-read-edit-bash')
  assert.equal(skillSlug(['Read File', 'bash']), 'auto-read-file-bash')
  assert.equal(skillSlug(['x'.repeat(100)]).length <= 53, true)
  assert.equal(skillSlug([]), 'auto-procedure')
})

test('a rendered skill carries frontmatter, provenance, and the order', () => {
  const candidate = skillCandidates([1, 2, 3].map(turn => observation({ turn })))[0]
  const text = renderSkill(candidate)
  assert.match(text, /^---\nname: auto-read-edit\n/)
  assert.match(text, /description: .+/)
  assert.match(text, /generated by dsh-fracture/)
  assert.match(text, /1\. `read`/)
  assert.match(text, /2\. `edit`/)
  assert.match(text, /add a test for the parser/)
})

test('a hand-written skill is never overwritten', async () => {
  const { root, store } = await scratch()
  try {
    const candidate = skillCandidates([1, 2, 3].map(turn => observation({ turn })))[0]
    const written = await writeSkill(store, candidate.slug, renderSkill(candidate))
    assert.notEqual(written, undefined)
    assert.equal((await listSkills(store))[0].generated, true)

    const handWritten = join(store.skillsDir, candidate.slug, 'SKILL.md')
    await mkdir(join(store.skillsDir, candidate.slug), { recursive: true })
    await writeFile(handWritten, '---\nname: mine\ndescription: hand edited\n---\n\nkeep me\n', 'utf8')
    assert.equal(await writeSkill(store, candidate.slug, renderSkill(candidate)), undefined)
    assert.match(await readFile(handWritten, 'utf8'), /keep me/)
    assert.equal((await listSkills(store))[0].generated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
