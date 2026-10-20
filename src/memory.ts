/**
 * Memory: what the loop has seen, and what it has concluded.
 *
 * Two files, both plain text, both append-or-replace by the loop itself:
 *
 * - `observations.jsonl` is the raw record. One line per turn, never edited.
 * - `MEMORY.md` is the rolling digest a summarizer subagent rewrites.
 *
 * Keeping them separate matters: the digest can be regenerated from the log,
 * but the log cannot be regenerated from the digest.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Observation } from './observe.js'
import type { Store } from './store.js'

/** Path of the append-only observation log. */
export function observationsPath(store: Store): string {
  return join(store.memoryDir, 'observations.jsonl')
}

/** Path of the rolling digest. */
export function digestPath(store: Store): string {
  return join(store.memoryDir, 'MEMORY.md')
}

/** Append observations, one JSON object per line. */
export async function appendObservations(store: Store, observations: readonly Observation[]): Promise<number> {
  if (observations.length === 0) return 0
  await mkdir(store.memoryDir, { recursive: true })
  const lines = observations.map(observation => JSON.stringify(observation)).join('\n')
  await appendFile(observationsPath(store), `${lines}\n`, 'utf8')
  return observations.length
}

/** Read up to `limit` newest observations; corrupt lines are skipped, not fatal. */
export async function readObservations(store: Store, limit: number): Promise<Observation[]> {
  let text: string
  try {
    text = await readFile(observationsPath(store), 'utf8')
  } catch {
    return []
  }
  const parsed: Observation[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      parsed.push(JSON.parse(trimmed) as Observation)
    } catch {
      // A truncated tail line is expected after a crash; skip it.
    }
  }
  return parsed.slice(-limit)
}

/** How many observations are stored, without materializing them. */
export async function countObservations(store: Store): Promise<number> {
  const all = await readObservations(store, Number.MAX_SAFE_INTEGER)
  return all.length
}

/** Read the digest, or an empty string when it has never been written. */
export async function readDigest(store: Store): Promise<string> {
  try {
    return await readFile(digestPath(store), 'utf8')
  } catch {
    return ''
  }
}

/** Replace the digest. */
export async function writeDigest(store: Store, markdown: string): Promise<void> {
  await mkdir(store.memoryDir, { recursive: true })
  await writeFile(digestPath(store), markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8')
}

/** One journal line: the loop's own audit trail, independent of any session. */
export async function journal(store: Store, line: string): Promise<void> {
  await mkdir(store.baseDir, { recursive: true })
  await appendFile(store.journalPath, `- ${new Date().toISOString()} ${line}\n`, 'utf8')
}

/** Read the journal tail for the status view. */
export async function readJournal(store: Store, limit: number): Promise<string[]> {
  try {
    const text = await readFile(store.journalPath, 'utf8')
    return text.split('\n').filter(line => line.trim() !== '').slice(-limit)
  } catch {
    return []
  }
}

/** One search hit. */
export interface MemoryHit {
  readonly kind: 'digest' | 'observation' | 'skill'
  readonly at: string
  readonly text: string
}

/**
 * Search the digest, the observation log, and the skill descriptions.
 * @param store - layout owner.
 * @param query - case-insensitive substring; an empty query returns the newest observations.
 * @param limit - maximum hits.
 * @returns newest-first hits.
 */
export async function searchMemory(store: Store, query: string, limit: number): Promise<MemoryHit[]> {
  const needle = query.trim().toLowerCase()
  const hits: MemoryHit[] = []

  const digest = await readDigest(store)
  if (digest !== '') {
    for (const line of digest.split('\n')) {
      if (needle === '' || line.toLowerCase().includes(needle)) {
        hits.push({ kind: 'digest', at: '', text: line })
      }
    }
  }

  const observations = await readObservations(store, 500)
  for (const observation of observations) {
    const haystack = [observation.task, Object.keys(observation.tools).join(' '), observation.sequence.join(' ')]
      .join(' ')
      .toLowerCase()
    if (needle === '' || haystack.includes(needle)) {
      const failures = observation.failures.length === 0 ? 'ok' : `${String(observation.failures.length)} failure(s)`
      hits.push({
        kind: 'observation',
        at: observation.at,
        text: `${observation.at} ${observation.sequence.join(' > ')} | ${observation.task} | ${failures}`,
      })
    }
  }

  return hits.slice(-limit).reverse()
}

/** The compact index a prompt section can afford to carry. */
export interface MemoryIndex {
  readonly digestHeadings: readonly string[]
  readonly skillNames: readonly string[]
  readonly observations: number
}

/** Build a bounded index: headings and names only, never content. */
export async function memoryIndex(store: Store, skills: readonly { name: string }[], maxHeadings = 8): Promise<MemoryIndex> {
  const digest = await readDigest(store)
  const headings = digest
    .split('\n')
    .filter(line => line.startsWith('## ') || line.startsWith('### '))
    .map(line => line.replace(/^#+\s*/, '').trim())
    .slice(0, maxHeadings)
  return {
    digestHeadings: headings,
    skillNames: skills.map(skill => skill.name).slice(0, 20),
    observations: await countObservations(store),
  }
}
