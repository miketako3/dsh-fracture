/**
 * Acceptance criteria: what would count as done, written before the work.
 *
 * The loop can only judge a change when a task has something checkable behind
 * it. Most real requests arrive as a sentence of intent, so this module turns
 * that sentence into checks, and refuses when it cannot. A refusal is a useful
 * answer: it says the request needs a human decision, not a loop iteration.
 *
 * Two kinds of check exist because two kinds of work do. A `command` exits
 * non-zero when the work is not done, which the probe can run. A `check` is a
 * condition a reader confirms from the transcript, which only the rubric can
 * read. The prompt asks for commands first and accepts checks only when the
 * work has no command behind it.
 */

/** One condition that must hold for the task to count as done. */
export interface Criterion {
  readonly kind: 'command' | 'check'
  /** A shell command, or a sentence a reader can confirm. */
  readonly text: string
  /** Why this follows from the request. */
  readonly why: string
}

/** The criteria for one task, as stored under `criteria/`. */
export interface Criteria {
  readonly id: string
  /** The request this answers, verbatim. */
  readonly task: string
  /** Empty means the request could not be made checkable. */
  readonly checks: readonly Criterion[]
  /** Why the request cannot be made checkable, when `checks` is empty. */
  readonly refusal?: string
  /** The first command check, usable as a probe's `verify`. */
  readonly verify?: string
  readonly createdAt: string
}

const MAX_CHECKS = 5

/** A stable id for a task, so the same request reuses its criteria. */
export function criteriaId(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  // A task with no Latin characters still needs a name; the digest keeps the text.
  return slug === '' ? `task-${String(task.length)}` : slug
}

/**
 * The prompt that asks a model for criteria.
 * @param task - the request, verbatim.
 * @param context - what the harness has seen fail recently, so criteria can target it.
 * @returns the prompt text.
 */
export function buildCriteriaPrompt(task: string, context: readonly string[] = []): string {
  return [
    'You turn a request into acceptance criteria for a coding agent harness.',
    '',
    'A good criterion is a condition that is false before the work and true after it.',
    'Two kinds are allowed:',
    '',
    '- `command`: a shell command that exits non-zero while the work is not done.',
    '  Prefer this. It is what an automated check can run.',
    '- `check`: a sentence a reader can confirm from the transcript, when no command exists.',
    '  Use it only for work that leaves no artefact to test, such as a decision or an explanation.',
    '',
    'Rules:',
    '',
    '- Between two and five criteria. Fewer is better; one that is not needed is a liability.',
    '- Every criterion must be answerable from the repository or the transcript. No "the user is happy".',
    '- Do not invent file paths or commands that the request does not imply.',
    '- If the request cannot be made checkable, return no checks and say why in one sentence.',
    '',
    'Reply with JSON and nothing else:',
    '',
    '{"checks": [{"kind": "command", "text": "npm test", "why": "the change must not break the suite"}], "refusal": "only when checks is empty"}',
    '',
    '## Request',
    '',
    '```text',
    task.trim(),
    '```',
    '',
    ...(context.length === 0 ? [] : ['## What has been failing here', '', ...context.map(line => `- ${line}`), '']),
  ].join('\n')
}

function firstObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a criteria reply.
 * @param reply - the model's text.
 * @param task - the request it answers.
 * @param now - ISO time to stamp the record with.
 * @returns the criteria, or undefined when the reply is not usable.
 */
export function parseCriteria(reply: string, task: string, now: string): Criteria | undefined {
  const object = firstObject(reply)
  if (object === undefined) return undefined
  const raw = Array.isArray(object['checks']) ? object['checks'] : []
  const checks: Criterion[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const kind = record['kind']
    const text = record['text']
    if ((kind !== 'command' && kind !== 'check') || typeof text !== 'string' || text.trim() === '') continue
    const why = typeof record['why'] === 'string' ? record['why'].trim() : ''
    checks.push({ kind, text: text.trim(), why })
    if (checks.length >= MAX_CHECKS) break
  }
  const refusal = typeof object['refusal'] === 'string' ? object['refusal'].trim() : ''
  if (checks.length === 0 && refusal === '') return undefined

  const verify = checks.find(check => check.kind === 'command')?.text
  return {
    id: criteriaId(task),
    task,
    checks,
    ...(checks.length === 0 ? { refusal } : {}),
    ...(verify === undefined ? {} : { verify }),
    createdAt: now,
  }
}

/** Render criteria for a tool result. */
export function renderCriteria(criteria: Criteria): string {
  const head = ['# Acceptance criteria', '', `\`\`\`text\n${criteria.task.trim()}\n\`\`\``, '']
  if (criteria.checks.length === 0) {
    return [
      ...head,
      'This request cannot be made checkable as written.',
      '',
      criteria.refusal ?? 'No reason was given.',
      '',
      'What would make it checkable is a decision about the outcome, not a change to the harness.',
    ].join('\n')
  }
  return [
    ...head,
    '| # | kind | criterion | why |',
    '| --- | --- | --- | --- |',
    ...criteria.checks.map((check, index) => `| ${String(index + 1)} | ${check.kind} | ${check.text} | ${check.why} |`),
    '',
    criteria.verify === undefined
      ? 'No command check, so a probe of this task will be judged by a rubric read.'
      : `\`fracture_probe\` uses this as its check when the candidate declares none:\n\n\`\`\`text\n${criteria.verify}\n\`\`\``,
    '',
    `Saved as \`criteria/${criteria.id}.json\`.`,
  ].join('\n')
}
