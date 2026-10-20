import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateWorkspace } from '../lib/workspace.js'
import { Store, writeJson } from '../lib/store.js'
import { adopt, latestProbe } from '../lib/adopt.js'

async function scratch() {
  return await mkdtemp(join(tmpdir(), 'self-harness-'))
}

test('isolation copies the tree, skips build output, and links dependencies', async () => {
  const root = await scratch()
  try {
    const source = join(root, 'src')
    await mkdir(join(source, 'pkg'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(source, 'dist'), { recursive: true })
    await writeFile(join(source, 'a.txt'), 'a', 'utf8')
    await writeFile(join(source, 'pkg', 'b.txt'), 'b', 'utf8')
    await writeFile(join(source, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8')
    await writeFile(join(source, 'dist', 'out.js'), 'out', 'utf8')

    const isolated = await isolateWorkspace(source, join(root, 'copy'))
    assert.equal(await readFile(join(isolated.dir, 'a.txt'), 'utf8'), 'a')
    assert.equal(await readFile(join(isolated.dir, 'pkg', 'b.txt'), 'utf8'), 'b')
    assert.equal(existsSync(join(isolated.dir, 'node_modules', 'dep', 'index.js')), true)
    assert.deepEqual(isolated.linked, ['node_modules'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an excluded absolute directory is not copied', async () => {
  const root = await scratch()
  try {
    const source = join(root, 'src')
    await mkdir(join(source, '.dsh', 'self-harness'), { recursive: true })
    await writeFile(join(source, 'keep.txt'), 'k', 'utf8')
    await writeFile(join(source, '.dsh', 'self-harness', 'big.json'), '{}', 'utf8')
    const isolated = await isolateWorkspace(source, join(root, 'copy'), [join(source, '.dsh')])
    assert.equal(existsSync(join(isolated.dir, 'keep.txt')), true)
    assert.equal(existsSync(join(isolated.dir, '.dsh')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeJson replaces atomically and leaves no temp file', async () => {
  const root = await scratch()
  try {
    const path = join(root, 'deep', 'dir', 'x.json')
    await writeJson(path, { a: 1 })
    await writeJson(path, { a: 2 })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 })
    assert.deepEqual(await readdir(join(root, 'deep', 'dir')), ['x.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a candidate round-trips and its patch is regenerated', async () => {
  const root = await scratch()
  try {
    const store = new Store(root)
    await store.ensure()
    const candidate = { id: 'brief', title: 'Be brief', rationale: 'noise', finding: 'rereads', lever: 'prompt', rows: [{ name: '@deepseek-ai/dsh-persona', config: { prefix: 'Be brief.' } }] }
    const written = await store.writeCandidate(candidate)
    assert.deepEqual(await store.readCandidate('brief'), candidate)
    assert.match(await readFile(written.patchPath, 'utf8'), /^- insert:$/m)
    assert.deepEqual(await store.listCandidateIds(), ['brief'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reading a missing candidate explains what to do', async () => {
  const root = await scratch()
  try {
    await assert.rejects(new Store(root).readCandidate('nope'), /self_propose/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lessons append instead of replacing', async () => {
  const root = await scratch()
  try {
    const store = new Store(root)
    await store.appendLesson('## one\ntext')
    await store.appendLesson('## two\ntext')
    const text = await readFile(store.lessonsPath, 'utf8')
    assert.match(text, /## one/)
    assert.match(text, /## two/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('adoption refuses a candidate that never improved', async () => {
  const root = await scratch()
  try {
    const store = new Store(root)
    await store.ensure()
    await store.writeCandidate({ id: 'brief', title: 't', rationale: 'r', finding: 'f', lever: 'prompt', rows: [{ name: '@deepseek-ai/dsh-persona' }] })
    await mkdir(store.runDir('r1-brief'), { recursive: true })
    await writeJson(join(store.runDir('r1-brief'), 'result.json'), { runId: 'r1-brief', candidateId: 'brief', verdict: 'no-change', reason: 'same' })
    const candidate = await store.readCandidate('brief')
    await assert.rejects(
      adopt(store, candidate, { packagePrefix: 'cand', apply: false, force: false }),
      /no-change/,
    )
    const forced = await adopt(store, candidate, { packagePrefix: 'cand', apply: false, force: true })
    assert.equal(forced.verdict, 'no-change')
    assert.equal(forced.packageName, 'cand-brief')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('adoption rewrites a probe-relative plugin row to the bundle package', async () => {
  const root = await scratch()
  try {
    const store = new Store(root)
    await store.ensure()
    await store.writeCandidate({
      id: 'tool',
      title: 't',
      rationale: 'r',
      finding: 'f',
      lever: 'tool',
      rows: [{ name: './plugin/index.js' }],
    })
    await mkdir(store.runDir('r2-tool'), { recursive: true })
    await writeJson(join(store.runDir('r2-tool'), 'result.json'), { runId: 'r2-tool', candidateId: 'tool', verdict: 'improved', reason: 'better' })
    const candidate = await store.readCandidate('tool')
    const outcome = await adopt(store, candidate, { packagePrefix: 'cand', apply: false, force: false })
    const patch = await readFile(join(outcome.bundleDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /name: cand-tool/)
    const manifest = JSON.parse(await readFile(join(outcome.bundleDir, 'package.json'), 'utf8'))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(manifest.private, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the newest probe is the one adoption reads', async () => {
  const root = await scratch()
  try {
    const store = new Store(root)
    await store.ensure()
    await mkdir(store.runDir('2020-x'), { recursive: true })
    await writeJson(join(store.runDir('2020-x'), 'result.json'), { runId: '2020-x', candidateId: 'x', verdict: 'regressed' })
    await mkdir(store.runDir('2021-x'), { recursive: true })
    await writeJson(join(store.runDir('2021-x'), 'result.json'), { runId: '2021-x', candidateId: 'x', verdict: 'improved' })
    assert.equal((await latestProbe(store, 'x')).verdict, 'improved')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a symlinked dependency directory stays a symlink', async () => {
  const root = await scratch()
  try {
    const source = join(root, 'src')
    await mkdir(join(source, 'node_modules'), { recursive: true })
    await writeFile(join(source, 'node_modules', 'f.js'), 'f', 'utf8')
    const isolated = await isolateWorkspace(source, join(root, 'copy'))
    assert.equal(existsSync(join(isolated.dir, 'node_modules', 'f.js')), true)
    // The copy must not duplicate the directory contents.
    assert.deepEqual(await readdir(isolated.dir), ['node_modules'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
