/**
 * Pure diagnosis over stored session events.
 *
 * The rules here turn counts into ranked findings. They deliberately describe
 * what was observed instead of what to change: choosing the edit is the
 * proposer's job, and pre-deciding it here would make every candidate look the
 * same.
 */

import {
  DEFAULT_DIAGNOSE_OPTIONS,
  type DiagnoseOptions,
  type Diagnosis,
  type Finding,
  type RawEvent,
  type ToolStat,
} from './types.js'

interface SessionFacts {
  readonly calls: Map<string, number>
  readonly failures: Map<string, number>
  readonly reads: Map<string, number>
  denied: number
  compactions: number
  inputTokens: number
  outputTokens: number
  sawUsage: boolean
  positive: number
  negative: number
}

const READ_TOOLS = new Set(['read', 'read_file', 'read_text_file', 'cat', 'view', 'open_file'])
const DENIAL_WORDS = new Set(['deny', 'denied', 'reject', 'rejected', 'blocked'])

function emptyFacts(): SessionFacts {
  return {
    calls: new Map(),
    failures: new Map(),
    reads: new Map(),
    denied: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    sawUsage: false,
    positive: 0,
    negative: 0,
  }
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

/** Read a dotted path out of an unknown record without trusting its shape. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The target path of a read-like call, when the arguments carry one. */
function readPath(rawArguments: unknown): string | undefined {
  if (typeof rawArguments !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  for (const key of ['path', 'file_path', 'filePath', 'target', 'file']) {
    const candidate = at(parsed, key)
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** Whether a tool result records a failure. */
function failedResult(data: Record<string, unknown>): boolean {
  if (data['error'] !== undefined && data['error'] !== null) return true
  const isError = at(data, 'message', 'isError')
  return isError === true
}

/** Sum the usage numbers a result or message carries, when it carries any. */
function absorbUsage(facts: SessionFacts, data: Record<string, unknown>): void {
  const usage = at(data, 'usage') ?? at(data, 'message', 'usage')
  if (typeof usage !== 'object' || usage === null) return
  const input = numberOf(at(usage, 'input')) + numberOf(at(usage, 'inputTokens')) + numberOf(at(usage, 'promptTokens'))
  const output = numberOf(at(usage, 'output')) + numberOf(at(usage, 'outputTokens')) + numberOf(at(usage, 'completionTokens'))
  if (input === 0 && output === 0) return
  facts.sawUsage = true
  facts.inputTokens += input
  facts.outputTokens += output
}

/** Read one feedback rating out of any of the shapes a log may store it in. */
function feedbackRating(data: Record<string, unknown>): 'positive' | 'negative' | undefined {
  const candidates = [at(data, 'rating'), at(data, 'item', 'rating'), at(data, 'value'), at(data, 'value', 'rating')]
  for (const candidate of candidates) {
    if (candidate === 'positive' || candidate === 'negative') return candidate
  }
  return undefined
}

/** Fold one session's events into its facts. */
function foldSession(events: readonly RawEvent[]): SessionFacts {
  const facts = emptyFacts()
  const callsById = new Map<string, string>()

  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'tool/call') {
      const name = typeof data['name'] === 'string' ? data['name'] : 'unknown'
      bump(facts.calls, name)
      const callId = data['callId']
      if (typeof callId === 'string') callsById.set(callId, name)
      if (READ_TOOLS.has(name)) {
        const path = readPath(data['arguments'])
        if (path !== undefined) bump(facts.reads, path)
      }
      continue
    }

    if (event.type === 'tool/result') {
      const callId = data['callId']
      const name = (typeof callId === 'string' ? callsById.get(callId) : undefined)
        ?? (typeof data['name'] === 'string' ? data['name'] : 'unknown')
      if (failedResult(data)) bump(facts.failures, name)
      absorbUsage(facts, data)
      continue
    }

    if (event.type === 'assistant/message') {
      absorbUsage(facts, data)
      continue
    }

    if (event.type.startsWith('approval/')) {
      const decision = at(data, 'decision') ?? at(data, 'outcome') ?? at(data, 'status')
      if (typeof decision === 'string' && DENIAL_WORDS.has(decision.toLowerCase())) facts.denied += 1
      continue
    }

    if (event.type.includes('compaction')) {
      facts.compactions += 1
      continue
    }

    if (event.type.startsWith('feedback/')) {
      const rating = feedbackRating(data)
      if (rating === 'positive') facts.positive += 1
      else if (rating === 'negative') facts.negative += 1
    }
  }

  return facts
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 }

/** Rank findings so the proposer always reads the strongest evidence first. */
function rank(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
}

/**
 * Aggregate stored events into one diagnosis.
 * @param sessions - events of each session that should contribute.
 * @param options - thresholds; omitted fields fall back to the defaults.
 * @returns counts, per-tool statistics, and ranked findings.
 */
export function diagnose(sessions: readonly (readonly RawEvent[])[], options: Partial<DiagnoseOptions> = {}): Diagnosis {
  const config: DiagnoseOptions = { ...DEFAULT_DIAGNOSE_OPTIONS, ...options }
  const totals = emptyFacts()
  let events = 0
  let rereadSessions = 0
  let worstRereads: { path: string; count: number } | undefined

  for (const session of sessions) {
    const facts = foldSession(session)
    events += session.length
    for (const [name, count] of facts.calls) bump(totals.calls, name, count)
    for (const [name, count] of facts.failures) bump(totals.failures, name, count)
    totals.denied += facts.denied
    totals.compactions += facts.compactions
    totals.inputTokens += facts.inputTokens
    totals.outputTokens += facts.outputTokens
    totals.sawUsage ||= facts.sawUsage
    totals.positive += facts.positive
    totals.negative += facts.negative

    const heavy = [...facts.reads.entries()].filter(([, count]) => count >= config.rereadThreshold)
    if (heavy.length > 0) {
      rereadSessions += 1
      for (const [path, count] of heavy) {
        if (worstRereads === undefined || count > worstRereads.count) worstRereads = { path, count }
      }
    }
  }

  const toolStats: ToolStat[] = [...totals.calls.entries()]
    .map(([name, calls]) => ({ name, calls, failures: totals.failures.get(name) ?? 0 }))
    .sort((left, right) => right.calls - left.calls)

  const findings: Finding[] = []

  const failing = toolStats
    .filter(stat => stat.calls >= config.minCalls && stat.failures / stat.calls >= config.failureRatio)
    .sort((left, right) => right.failures / right.calls - left.failures / left.calls)

  for (const stat of failing) {
    const ratio = Math.round((stat.failures / stat.calls) * 100)
    findings.push({
      id: `tool-failures:${stat.name}`,
      severity: ratio >= 50 ? 'high' : 'medium',
      evidence: `\`${stat.name}\` failed ${stat.failures} of ${stat.calls} calls (${ratio}%).`,
      lever: 'prompt',
    })
  }

  if (worstRereads !== undefined) {
    findings.push({
      id: 'rereads',
      severity: worstRereads.count >= config.rereadThreshold * 2 ? 'medium' : 'low',
      evidence: `A single path was read ${worstRereads.count} times in one session (${worstRereads.path}), in ${rereadSessions} session(s).`,
      lever: 'skill',
    })
  }

  if (totals.denied >= config.denialThreshold) {
    findings.push({
      id: 'approval-friction',
      severity: 'medium',
      evidence: `${totals.denied} operations were denied by the approval policy.`,
      lever: 'tool',
    })
  }

  if (totals.compactions >= 2) {
    findings.push({
      id: 'context-pressure',
      severity: 'medium',
      evidence: `History was compacted ${totals.compactions} times across ${sessions.length} session(s).`,
      lever: 'prompt',
    })
  }

  if (totals.negative >= 2 && totals.negative >= totals.positive) {
    findings.push({
      id: 'negative-feedback',
      severity: 'high',
      evidence: `${totals.negative} negative and ${totals.positive} positive message ratings.`,
      lever: 'prompt',
    })
  }

  return {
    sessions: sessions.length,
    events,
    toolStats,
    findings: rank(findings),
    feedback: { positive: totals.positive, negative: totals.negative },
    tokens: totals.sawUsage ? { input: totals.inputTokens, output: totals.outputTokens } : null,
    generatedAt: new Date().toISOString(),
  }
}
