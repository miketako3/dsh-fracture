/**
 * Adoption.
 *
 * A probe decides whether a candidate helped; adoption decides whether it
 * becomes part of the harness. The two are separate steps on purpose, and
 * adoption always leaves a bundle behind so the change can be published,
 * reviewed, or reverted without reconstructing it from a transcript.
 */

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Candidate, PresetRow, ProbeResult, Verdict } from './types.js'
import { candidateProblems } from './guard.js'
import { renderPatch, writeJson, type Store } from './store.js'

/** What one adoption produced. */
export interface AdoptOutcome {
  readonly candidateId: string
  readonly bundleDir: string
  readonly packageName: string
  readonly verdict: Verdict | 'forced'
  readonly applied: boolean
  readonly instructions: string
}

/** Settings an adoption needs. */
export interface AdoptSettings {
  /** Package name prefix; the candidate id is appended. */
  readonly packagePrefix: string
  /** Append the generated rows to this profile patch when `apply` is set. */
  readonly profilePatch?: string
  readonly apply: boolean
  readonly force: boolean
}

/** Find the newest probe result recorded for one candidate. */
export async function latestProbe(store: Store, candidateId: string): Promise<ProbeResult | undefined> {
  let names: string[]
  try {
    names = await readdir(store.runsDir)
  } catch {
    return undefined
  }
  const mine = names.filter(name => name.endsWith(`-${candidateId}`)).sort()
  for (const name of mine.reverse()) {
    try {
      const text = await readFile(join(store.runsDir, name, 'result.json'), 'utf8')
      return JSON.parse(text) as ProbeResult
    } catch {
      continue
    }
  }
  return undefined
}

/** A bundle-local row names the bundle package instead of a probe-relative path. */
function bundleRows(rows: readonly PresetRow[], packageName: string): PresetRow[] {
  return rows.map((row) => {
    if (!row.name.startsWith('.')) return { ...row }
    return { ...row, name: packageName }
  })
}

/** Version requirements the bundle must carry so its rows resolve. */
function bundleDependencies(rows: readonly PresetRow[]): Record<string, string> {
  const dependencies: Record<string, string> = {}
  for (const row of rows) {
    if (row.name.startsWith('.') || !row.name.includes('/')) continue
    if (!row.name.startsWith('@') && !row.name.startsWith('dsh-')) continue
    dependencies[row.name] = '*'
  }
  return dependencies
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    const entries = await readdir(source)
    if (entries.length === 0) return false
    await cp(source, destination, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Promote a probed candidate into an installable bundle.
 * @param store - layout owner.
 * @param candidate - candidate to adopt.
 * @param settings - naming, target patch, and whether to write instead of plan.
 * @returns the bundle location and the exact install steps.
 */
export async function adopt(store: Store, candidate: Candidate, settings: AdoptSettings): Promise<AdoptOutcome> {
  const problems = candidateProblems(candidate)
  if (problems.length > 0) throw new Error(`candidate ${candidate.id} is not adoptable:\n- ${problems.join('\n- ')}`)

  const probe = await latestProbe(store, candidate.id)
  if (probe === undefined && !settings.force) {
    throw new Error(`candidate ${candidate.id} has no probe result; run fracture_probe first, or pass force to adopt without evidence`)
  }
  if (probe !== undefined && probe.verdict !== 'improved' && !settings.force) {
    throw new Error(
      `candidate ${candidate.id} probed as "${probe.verdict}": ${probe.reason}\nAdopting anyway requires force, and the lesson should record why.`,
    )
  }

  const packageName = `${settings.packagePrefix}-${candidate.id}`
  const bundleDir = join(store.candidateDir(candidate.id), 'bundle')
  await mkdir(bundleDir, { recursive: true })

  const rows = bundleRows(candidate.rows, packageName)
  await writeFile(join(bundleDir, 'cordis.patch.yml'), renderPatch(rows), 'utf8')

  const hasPlugin = await copyIfPresent(join(store.candidateDir(candidate.id), 'plugin'), join(bundleDir, 'plugin'))
  const hasSkills = await copyIfPresent(join(store.candidateDir(candidate.id), 'skills'), join(bundleDir, 'skills'))

  const manifest: Record<string, unknown> = {
    name: packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: candidate.title,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: bundleDependencies(rows),
  }
  if (hasPlugin) {
    manifest['main'] = './plugin/index.js'
    manifest['exports'] = { '.': './plugin/index.js', './plugin/*': './plugin/*' }
  }
  await writeJson(join(bundleDir, 'package.json'), manifest)

  const instructions = [
    `# Adopting ${candidate.id}`,
    '',
    `Title: ${candidate.title}`,
    `Probe verdict: ${probe?.verdict ?? 'none'}${probe === undefined ? ' (forced)' : ''}`,
    '',
    '## Steps',
    '',
    '1. Review `bundle/cordis.patch.yml` and `bundle/package.json`; the patch is the whole change.',
    '2. Publish or install the bundle, for example `npm publish` from `bundle/`, then `dsh plugin add ' + packageName + '`.',
    '3. Or install the bundle from this directory with the `plugin_manager` tool, which asks the human before installing host code.',
    '4. Restart the session so the new rows load, then run the probe task again by hand and compare.',
    '',
    hasSkills ? 'Skills under `bundle/skills/` load through the skill roots the patch points at.' : '',
    hasPlugin ? 'Code under `bundle/plugin/` runs in the DSH process; read it before installing.' : '',
    '',
    '## Reverting',
    '',
    `Remove the bundle (or \`dsh plugin remove ${packageName}\`) and the rows disappear with it.`,
    'Nothing else in the profile was touched.',
    '',
  ].filter(line => line !== undefined).join('\n')

  await writeFile(join(bundleDir, 'ADOPT.md'), instructions, 'utf8')

  let applied = false
  if (settings.apply && settings.profilePatch !== undefined) {
    const layer = renderPatch(rows)
    let existing = ''
    try {
      existing = await readFile(settings.profilePatch, 'utf8')
    } catch {
      existing = '# Profile composition layers.\n'
    }
    const separator = existing.endsWith('\n') ? '' : '\n'
    await writeFile(settings.profilePatch, `${existing}${separator}${layer}`, 'utf8')
    applied = true
  }

  return {
    candidateId: candidate.id,
    bundleDir,
    packageName,
    verdict: probe?.verdict ?? 'forced',
    applied,
    instructions,
  }
}
