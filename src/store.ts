/**
 * Filesystem layout for the loop.
 *
 * Everything the agent authors is plain files under one base directory so the
 * user can read, diff, and revert it with normal tools. JSON is the source of
 * truth; the Cordis patch is generated from it.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Candidate, PresetRow } from './types.js'

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/

/** A filesystem-safe, sortable UTC stamp for run and diagnosis directories. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()
}

/** Reject ids that could escape the base directory. */
export function assertSafeId(id: string, what: string): string {
  if (!SAFE_ID.test(id) || id.includes('..')) {
    throw new Error(`${what} must match ${String(SAFE_ID)} (got ${JSON.stringify(id)})`)
  }
  return id
}

/** The on-disk layout under the configured base directory. */
export class Store {
  constructor(readonly baseDir: string) {}

  get diagnosesDir(): string { return join(this.baseDir, 'diagnoses') }
  get candidatesDir(): string { return join(this.baseDir, 'candidates') }
  get runsDir(): string { return join(this.baseDir, 'runs') }
  get lessonsPath(): string { return join(this.baseDir, 'lessons.md') }
  get memoryDir(): string { return join(this.baseDir, 'memory') }
  get skillsDir(): string { return join(this.baseDir, 'skills') }
  get journalPath(): string { return join(this.baseDir, 'journal.md') }

  /** Create the base layout once; safe to call on every tool invocation. */
  async ensure(): Promise<void> {
    await mkdir(this.diagnosesDir, { recursive: true })
    await mkdir(this.candidatesDir, { recursive: true })
    await mkdir(this.runsDir, { recursive: true })
    await mkdir(this.memoryDir, { recursive: true })
    await mkdir(this.skillsDir, { recursive: true })
  }

  candidateDir(id: string): string {
    return join(this.candidatesDir, assertSafeId(id, 'candidate id'))
  }

  runDir(id: string): string {
    return join(this.runsDir, assertSafeId(id, 'run id'))
  }

  /** Persist one diagnosis snapshot and return its path. */
  async saveDiagnosis(diagnosis: unknown, stamp: string): Promise<string> {
    const path = join(this.diagnosesDir, `${assertSafeId(stamp, 'diagnosis stamp')}.json`)
    await writeJson(path, diagnosis)
    return path
  }

  /** Read a candidate, or throw a message the model can act on. */
  async readCandidate(id: string): Promise<Candidate> {
    const path = join(this.candidateDir(id), 'candidate.json')
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error(`no candidate at ${path}; run self_propose first or check the id`)
    }
    return JSON.parse(text) as Candidate
  }

  /** Ids of every candidate this base directory holds, newest last. */
  async listCandidateIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.candidatesDir, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    } catch {
      return []
    }
  }

  /** Write a candidate and its generated patch; returns both paths. */
  async writeCandidate(candidate: Candidate): Promise<{ dir: string; patchPath: string }> {
    const dir = this.candidateDir(candidate.id)
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'candidate.json'), candidate)
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, renderPatch(candidate.rows), 'utf8')
    return { dir, patchPath }
  }

  /** Append one lesson section. Append-only keeps earlier evidence readable. */
  async appendLesson(markdown: string): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    let existing = '# Lessons\n'
    try {
      existing = await readFile(this.lessonsPath, 'utf8')
    } catch {
      // First lesson.
    }
    const separator = existing.endsWith('\n') ? '\n' : '\n\n'
    await writeFile(this.lessonsPath, `${existing}${separator}${markdown.trimEnd()}\n`, 'utf8')
  }

  /** Remove one run directory (probe workspaces are large). */
  async dropRun(id: string): Promise<void> {
    await rm(this.runDir(id), { recursive: true, force: true })
  }
}

/** Write JSON atomically so a crash never leaves a half-written candidate. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

const BLOCK_KEY = /^[a-z][a-z0-9_-]*$/i
const NEEDS_QUOTE = /^(true|false|null|yes|no|on|off|~|[0-9].*|[&*!|>%@`'"{[\]:,-].*)$/i

function yamlScalar(value: unknown, indent: string): string | undefined {
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const body = value.replace(/\n+$/, '').split('\n').map(line => (line === '' ? '' : `${indent}${line}`)).join('\n')
      return `|\n${body}`
    }
    if (value === '' || NEEDS_QUOTE.test(value) || value !== value.trim()) return JSON.stringify(value)
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  return undefined
}

/** Emit one config object in readable YAML, or JSON flow when the shape is too deep. */
function yamlConfig(config: unknown, indent: string): string {
  if (typeof config !== 'object' || config === null) return ` ${JSON.stringify(config)}`
  const entries = Object.entries(config as Record<string, unknown>)
  if (entries.length === 0) return ' {}'
  const inner = `${indent}  `
  const lines: string[] = []
  for (const [key, value] of entries) {
    if (!BLOCK_KEY.test(key)) return ` ${JSON.stringify(config)}`
    if (Array.isArray(value)) {
      const scalars = value.map(item => yamlScalar(item, inner))
      if (scalars.some(item => item === undefined || item.includes('\n'))) return ` ${JSON.stringify(config)}`
      if (scalars.length === 0) {
        lines.push(`${inner}${key}: []`)
      } else {
        lines.push(`${inner}${key}:`)
        for (const scalar of scalars) lines.push(`${inner}  - ${String(scalar)}`)
      }
      continue
    }
    // A block scalar's body sits two columns deeper than its key.
    const scalar = yamlScalar(value, `${inner}  `)
    if (scalar === undefined) return ` ${JSON.stringify(config)}`
    lines.push(`${inner}${key}: ${scalar}`)
  }
  return `\n${lines.join('\n')}`
}

/**
 * Render composition rows as a Cordis patch layer.
 * @param rows - rows to insert above the current composition.
 * @returns YAML text ending in a newline.
 */
export function renderPatch(rows: readonly PresetRow[]): string {
  const header = [
    '# Generated by dsh-self-harness from candidate.json. Do not edit by hand.',
    '# Probe and adopt read candidate.json; this file only exists so a human can',
    '# read, diff, and paste the exact rows being evaluated.',
    '- insert:',
  ]
  const body = rows.map((row) => {
    const lines: string[] = []
    if (row.id !== undefined) lines.push(`    - id: ${assertPlain(row.id, 'row id')}`)
    else lines.push('    -')
    lines.push(`      name: ${assertPlain(row.name, 'row name')}`)
    if (row.disabled !== undefined) lines.push(`      disabled: ${String(row.disabled)}`)
    if (row.config !== undefined) lines.push(`      config:${yamlConfig(row.config, '      ')}`)
    return lines.join('\n')
  })
  return `${[...header, ...body].join('\n')}\n`
}

function assertPlain(value: string, what: string): string {
  if (!/^[\w@./:-]+$/.test(value)) throw new Error(`${what} must be a plain token (got ${JSON.stringify(value)})`)
  return value
}
