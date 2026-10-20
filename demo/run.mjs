#!/usr/bin/env node
/**
 * Run the automatic tiers against a scratch directory and print what they wrote.
 *
 * This is the loop without a model: synthetic session events in, memory and
 * skills out. Everything printed below is produced by the same modules the
 * plugin runs.
 *
 *   npm run demo
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Autopilot } from '../lib/autopilot.js'
import { Store } from '../lib/store.js'
import { readDigest, readJournal } from '../lib/memory.js'
import { listSkills } from '../lib/skills.js'

const root = await mkdtemp(join(tmpdir(), 'fracture-demo-'))
const store = new Store(root)
await store.ensure()

const clock = Date.UTC(2026, 9, 20, 9, 0, 0)
const pilot = new Autopilot(store, { digestEvery: 4, distillMinRepeats: 3 }, () => clock)

const TURNS = [
  { task: 'add pagination to the users endpoint', calls: ['read', 'edit', 'bash'], fails: false },
  { task: 'add pagination to the orders endpoint', calls: ['read', 'edit'], fails: false },
  { task: 'add pagination to the invoices endpoint', calls: ['read', 'edit'], fails: false },
  { task: 'fix the flaky export test', calls: ['read', 'bash'], fails: true, correction: 'no, the test is fine, the fixture is stale' },
  { task: 'add pagination to the audit endpoint', calls: ['read', 'edit', 'bash'], fails: false },
  { task: 'sort the pagination links by label', calls: ['read', 'edit'], fails: false },
]

function events(turn, sample) {
  const base = clock + turn * 1_000
  const out = [
    { type: 'turn/start', time: base, data: { turn } },
    { type: 'user/message', time: base + 1, data: { content: [{ type: 'text', text: sample.task }] } },
  ]
  sample.calls.forEach((name, at) => {
    const failing = sample.fails === true && at === sample.calls.length - 1
    out.push({ type: 'tool/call', time: base + 2 + at, data: { callId: `c${String(at)}`, name } })
    out.push({
      type: 'tool/result',
      time: base + 3 + at,
      data: {
        callId: `c${String(at)}`,
        message: { isError: failing, content: [] },
        ...(failing ? { error: { code: 'COMMAND_FAILED' } } : {}),
      },
    })
  })
  out.push({ type: 'assistant/message', time: base + 20, data: { usage: { inputTokens: 8_000 + turn * 500, outputTokens: 300 } } })
  if (sample.correction !== undefined) {
    out.push({ type: 'user/message', time: base + 25, data: { content: [{ type: 'text', text: sample.correction }] } })
  }
  out.push({ type: 'step/end', time: base + 30, data: { turn, step: 1 } })
  out.push({ type: 'turn/end', time: base + 40, data: { turn, reason: 'completed' } })
  return out
}

const line = (title) => `\n\x1b[1m${title}\x1b[0m`

console.log(`base directory: ${root}`)

for (const [index, sample] of TURNS.entries()) {
  const result = await pilot.observe('demo-session', events(index + 1, sample))
  if (result.skillsWritten.length > 0) {
    console.log(`${line('distilled')} ${result.skillsWritten.join(', ')}`)
  }
  if (result.digested) console.log(`${line('digest rewritten')} after turn ${String(index + 1)}`)
}

// A closing session rewrites the digest, so the demo does the same.
await pilot.refreshDigest()

console.log(line('memory/MEMORY.md'))
console.log(await readDigest(store))

console.log(line('skills/'))
for (const skill of await listSkills(store)) {
  console.log(`  ${skill.slug}/SKILL.md  (${String(skill.content.split('\n').length)} lines, generated: ${String(skill.generated)})`)
}

console.log(line('prompt index (what the model sees)'))
console.log(`  digest headings: ${pilot.index.digestHeadings.join(', ')}`)
console.log(`  skills: ${pilot.index.skillNames.join(', ')}`)
console.log(`  turns observed: ${String(pilot.index.observations)}`)

console.log(line('journal.md'))
console.log((await readJournal(store, 20)).join('\n'))

console.log(line('files written'))
for (const entry of await readdir(root, { recursive: true })) console.log(`  ${entry}`)

await rm(root, { recursive: true, force: true })
