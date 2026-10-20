/**
 * Proposal: one subagent writes a candidate harness edit as data.
 *
 * The proposer is a child agent, not the session that will live with the
 * change. It sees the diagnosis and the repository, writes files under
 * `candidates/<id>/`, and returns. Nothing it writes is trusted: the plugin
 * parses and guards every candidate before the probe may run it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Candidate, Diagnosis, Lever } from './types.js'
import { messageOf, runChild } from './child.js'
import { candidateProblems } from './guard.js'
import type { Store } from './store.js'

const LEVERS: readonly Lever[] = ['prompt', 'skill', 'script', 'tool', 'hook']

/** Settings a proposal needs. */
export interface ProposeSettings {
  readonly provider: string
  readonly timeoutMs: number
}

/** Everything one proposal needs from the host. */
export interface ProposeRequest {
  readonly ctx: Context
  readonly store: Store
  readonly settings: ProposeSettings
  readonly agent: Agent
  readonly diagnosis: Diagnosis
  readonly task: string
  readonly cwd: string
  readonly finding?: string
  readonly signal: AbortSignal
}

/** What one proposal produced. */
export interface ProposeOutcome {
  readonly accepted: readonly Candidate[]
  readonly rejected: readonly { readonly id: string; readonly problems: readonly string[] }[]
  readonly childMessage: string
}

const CANDIDATE_SHAPE = `{
  "id": "kebab-case-id",
  "title": "one line",
  "rationale": "why this helps, tied to the finding",
  "finding": "the finding id from the diagnosis",
  "lever": "prompt | skill | script | tool | hook",
  "verify": "optional shell command that exits non-zero when the harness fails",
  "rows": [
    { "id": "optional-row-id", "name": "@scope/package-or-plugin-id", "config": { } }
  ]
}`

function buildPrompt(request: ProposeRequest): string {
  const { diagnosis, task, finding, store, cwd } = request
  const findings = finding === undefined
    ? diagnosis.findings
    : diagnosis.findings.filter(item => item.id === finding || item.id.startsWith(finding))
  const tools = diagnosis.toolStats.slice(0, 10)

  return [
    'You are the proposer in a self-improvement loop for DeepSeek Harness (DSH).',
    'You do not run the experiment and you do not install anything. You write one candidate.',
    '',
    '## What a DSH harness is',
    '',
    'A harness is an ordered list of Cordis plugin rows. Each row is `{ id?, name, config? }`.',
    'A preset is such a list; a bundle ships the same rows in `cordis.patch.yml`.',
    'Editing the harness therefore means inserting or replacing rows, not editing agent code.',
    '',
    'Cheap rows, in the order you should prefer them:',
    '',
    '1. `prompt`: `@deepseek-ai/dsh-system-prompt` with a `personaPrefix` or `personaSuffix`, or',
    '   `@deepseek-ai/dsh-persona` with a `prefix` or `suffix`. Fixes wording problems.',
    '2. `skill`: `skills/<name>/SKILL.md` copied into `customSkillDirs`. Fixes a missing procedure.',
    '3. `script`: a small script the skill points at. Fixes a repeated, mechanical step.',
    '4. `tool`: `plugin/index.js` exporting a Cordis plugin that registers a tool. Fixes a missing capability.',
    '5. `hook`: a plugin that registers a pre-execute policy. Fixes a discipline that must be enforced, not requested.',
    '',
    'Prefer the weakest lever that plausibly works. A prompt row that is wrong costs one probe;',
    'a hook that is wrong changes every tool call.',
    '',
    '## Diagnosis',
    '',
    '```json',
    JSON.stringify({ sessions: diagnosis.sessions, feedback: diagnosis.feedback, tokens: diagnosis.tokens, toolStats: tools, findings }, null, 2),
    '```',
    '',
    findings.length === 0
      ? 'No finding was selected. If the list above is empty, say so and write nothing.'
      : `## Target\n\n${findings.map(item => `- \`${item.id}\` (${item.severity}, lever ${item.lever}): ${item.evidence}`).join('\n')}`,
    '',
    '## Task the harness should get better at',
    '',
    '```text',
    task.trim(),
    '```',
    '',
    '## What to write',
    '',
    `Write exactly one candidate directory: \`${join(store.candidatesDir, '<id>')}\`.`,
    'It must contain `candidate.json` with this shape:',
    '',
    '```json',
    CANDIDATE_SHAPE,
    '```',
    '',
    'Optional, only when the lever needs them:',
    '',
    '- `skills/<name>/SKILL.md` for a skill row.',
    '- `plugin/index.js` for a tool or hook row. Plain ESM, no build step, importing only',
    '  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, and Node builtins. Export `name` and `apply(ctx)`.',
    '  Use `name: "./plugin/index.js"` in the row; the adoption step rewrites it to the package name.',
    '',
    '## Rules',
    '',
    '- At most three rows. One effect per candidate, or the probe cannot attribute the result.',
    '- Never touch approval, sandbox policy, the plugin manager, or `dsh-fracture` itself.',
    '- `verify` should be a command that already exists in this repository and fails when the harness fails.',
    '  Omit it only when no such command exists.',
    '- Do not install anything, do not edit the profile, do not run `dsh`.',
    `- Work inside \`${cwd}\`; the candidate directory is the only path you write outside it.`,
    '- Do not ask questions. Finish by writing the files.',
    '',
  ].join('\n')
}

/** Validate one parsed candidate; throws with everything wrong at once. */
export function parseCandidate(fallbackId: string, raw: unknown): Candidate {
  if (typeof raw !== 'object' || raw === null) throw new Error('candidate.json must be an object')
  const record = raw as Record<string, unknown>
  const problems: string[] = []
  const id = typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : fallbackId
  const title = record['title']
  const rationale = record['rationale']
  const finding = record['finding']
  const lever = record['lever']
  const rows = record['rows']

  if (typeof title !== 'string' || title.trim() === '') problems.push('`title` must be a non-empty string')
  if (typeof rationale !== 'string' || rationale.trim() === '') problems.push('`rationale` must be a non-empty string')
  if (typeof finding !== 'string' || finding.trim() === '') problems.push('`finding` must name the diagnosis finding')
  if (typeof lever !== 'string' || !LEVERS.includes(lever as Lever)) problems.push(`\`lever\` must be one of ${LEVERS.join(', ')}`)
  if (!Array.isArray(rows)) problems.push('`rows` must be an array')
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    if (typeof row !== 'object' || row === null) {
      problems.push(`row ${String(index)} must be an object`)
      continue
    }
    const entry = row as Record<string, unknown>
    if (typeof entry['name'] !== 'string' || entry['name'] === '') problems.push(`row ${String(index)} needs a string \`name\``)
  }
  if (record['verify'] !== undefined && typeof record['verify'] !== 'string') problems.push('`verify` must be a string when present')
  if (record['prompt'] !== undefined) {
    if (typeof record['prompt'] !== 'string') problems.push('`prompt` must be a string when present')
    else if (record['prompt'].trim() === '') problems.push('`prompt` must not be empty when present')
    else if (record['prompt'].length > 4_000) problems.push('`prompt` must stay under 4000 characters')
  }
  if (problems.length > 0) throw new Error(problems.join('; '))

  const candidate: Candidate = {
    id,
    title: title as string,
    rationale: rationale as string,
    finding: finding as string,
    lever: lever as Lever,
    rows: rows as Candidate['rows'],
    ...(record['verify'] === undefined ? {} : { verify: record['verify'] as string }),
    ...(record['prompt'] === undefined ? {} : { prompt: (record['prompt'] as string).trim() }),
  }

  const guarded = candidateProblems(candidate)
  if (guarded.length > 0) throw new Error(guarded.join('; '))
  return candidate
}

/** Run the proposer child and collect the candidates it wrote. */
export async function propose(request: ProposeRequest): Promise<ProposeOutcome> {
  const { ctx, store, settings, agent, task, cwd, signal } = request
  await store.ensure()
  const before = new Set(await store.listCandidateIds())

  const combined = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)])
  let childMessage = ''
  let childError: string | undefined
  try {
    const run = await runChild(ctx, settings.provider, agent, buildPrompt(request), cwd, combined)
    childMessage = run.side.trajectory.finalText
    childError = run.side.error
  } catch (error) {
    childError = messageOf(error)
  }

  const after = await store.listCandidateIds()
  const created = after.filter(id => !before.has(id))
  const accepted: Candidate[] = []
  const rejected: { id: string; problems: string[] }[] = []

  for (const id of created) {
    // Read the directory name as the fallback id so a candidate that omits
    // `id` still lands somewhere predictable.
    try {
      const text = await readFile(join(store.candidateDir(id), 'candidate.json'), 'utf8')
      const candidate = parseCandidate(id, JSON.parse(text))
      if (candidate.id !== id) {
        rejected.push({ id, problems: [`candidate.json declares id "${candidate.id}" but lives in "${id}"`] })
        continue
      }
      accepted.push(candidate)
    } catch (error) {
      rejected.push({
        id,
        problems: [error instanceof SyntaxError ? `candidate.json is not valid JSON: ${error.message}` : messageOf(error)],
      })
    }
  }

  if (created.length === 0) {
    rejected.push({
      id: '(none)',
      problems: [childError === undefined ? 'the proposer wrote no candidate directory' : `the proposer failed: ${childError}`],
    })
  }

  return { accepted, rejected, childMessage }
}
