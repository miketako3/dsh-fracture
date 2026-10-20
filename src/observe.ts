/**
 * Observation extraction: stored session events in, per-turn facts out.
 *
 * This is the raw material for the whole autonomous tier. It runs on every turn
 * end, makes no model call, and must never throw on a log shape it does not
 * recognize: a bad observation is worse than no observation only if it is
 * silently wrong, so unknown events are skipped and counted rather than guessed.
 */

import type { RawEvent } from './types.js'

/** One turn's outcome, as recorded. */
export interface Observation {
  /** ISO time the turn ended. */
  readonly at: string
  readonly session: string
  readonly turn: number
  /** The human request that opened the turn, clipped. */
  readonly task: string
  /** Tool name to call count. */
  readonly tools: Record<string, number>
  /** Tool names in call order, consecutive repeats collapsed: the shape of the procedure. */
  readonly sequence: readonly string[]
  readonly failures: readonly { readonly tool: string; readonly code: string }[]
  /** Whether a later human message in the same turn reads as a correction. */
  readonly corrected: boolean
  readonly steps: number
  readonly durationMs: number
  readonly promptTokens?: number
  readonly outputTokens?: number
}

const MAX_TASK = 200
const MAX_CORRECTION = 400

const CORRECTION_PATTERNS: readonly RegExp[] = [
  /^(no|nope|stop|don't|do not|instead|actually|wait|wrong)\b/i,
  /(that'?s not|not what i|i (meant|said)|try again|redo)/i,
  /^(違う|いや|じゃなく|そうじゃ|やめて|だめ|ダメ|そうではなく)/,
  /(ではなく|じゃなくて|やり直し|もう一度)/,
]

/** Whether a human message reads as a correction rather than a new request. */
export function looksLikeCorrection(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_CORRECTION) return false
  return CORRECTION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('\n')
}

function atPath(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Mutable state for one turn while its events stream past. */
interface TurnState {
  turn: number
  startedAt?: number
  endedAt?: number
  task: string
  sawAssistant: boolean
  corrected: boolean
  steps: number
  calls: Map<string, string>
  tools: Record<string, number>
  sequence: string[]
  failures: { tool: string; code: string }[]
  promptTokens: number
  outputTokens: number
}

function emptyTurn(turn: number): TurnState {
  return {
    turn,
    task: '',
    sawAssistant: false,
    corrected: false,
    steps: 0,
    calls: new Map(),
    tools: {},
    sequence: [],
    failures: [],
    promptTokens: 0,
    outputTokens: 0,
  }
}

function finish(state: TurnState, session: string, fallbackAt: number): Observation {
  const ended = state.endedAt ?? fallbackAt
  const duration = state.startedAt === undefined ? 0 : Math.max(0, ended - state.startedAt)
  return {
    at: new Date(ended).toISOString(),
    session,
    turn: state.turn,
    task: clip(state.task, MAX_TASK),
    tools: state.tools,
    sequence: state.sequence,
    failures: state.failures,
    corrected: state.corrected,
    steps: state.steps,
    durationMs: duration,
    ...(state.promptTokens === 0 && state.outputTokens === 0
      ? {}
      : { promptTokens: state.promptTokens, outputTokens: state.outputTokens }),
  }
}

/**
 * Extract one observation per completed turn.
 * @param session - session id recorded on every observation.
 * @param events - stored events in log order.
 * @param now - fallback clock for logs without a closing `turn/end`.
 * @returns completed turns, oldest first; a trailing open turn is included with the current time.
 */
export function observationsFromSession(session: string, events: readonly RawEvent[], now = Date.now()): Observation[] {
  const out: Observation[] = []
  let current: TurnState | undefined
  let fallback = now

  for (const event of events) {
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : undefined
    if (time !== undefined) fallback = time

    if (event.type === 'turn/start') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
      if (current !== undefined) out.push(finish(current, session, fallback))
      current = emptyTurn(turn)
      if (time !== undefined) current.startedAt = time
      continue
    }

    if (event.type === 'turn/end') {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : current?.turn ?? 0
      const state = current ?? emptyTurn(turn)
      if (time !== undefined) state.endedAt = time
      out.push(finish(state, session, fallback))
      current = undefined
      continue
    }

    if (current === undefined) continue

    if (event.type === 'user/message') {
      const text = textOfContent(atPath(data, 'content') ?? data['message'])
      if (!current.sawAssistant) {
        if (current.task === '') current.task = text
      } else if (looksLikeCorrection(text)) {
        current.corrected = true
      }
      continue
    }

    if (event.type === 'assistant/message') {
      current.sawAssistant = true
      const usage = data['usage']
      if (typeof usage === 'object' && usage !== null) {
        const input = atPath(usage, 'inputTokens')
        const output = atPath(usage, 'outputTokens')
        if (typeof input === 'number') current.promptTokens += input
        if (typeof output === 'number') current.outputTokens += output
      }
      continue
    }

    if (event.type === 'step/end') {
      current.steps += 1
      continue
    }

    if (event.type === 'tool/call') {
      const name = typeof data['name'] === 'string' ? data['name'] : 'unknown'
      current.tools[name] = (current.tools[name] ?? 0) + 1
      if (current.sequence.at(-1) !== name) current.sequence.push(name)
      const callId = data['callId']
      if (typeof callId === 'string') current.calls.set(callId, name)
      continue
    }

    if (event.type === 'tool/result') {
      const callId = typeof data['callId'] === 'string' ? data['callId'] : ''
      const name = current.calls.get(callId) ?? (typeof data['name'] === 'string' ? data['name'] : 'unknown')
      const isError = atPath(data, 'message', 'isError') === true
      const error = data['error']
      if (isError || (error !== undefined && error !== null)) {
        const code = typeof atPath(error, 'code') === 'string' ? String(atPath(error, 'code')) : 'ERROR'
        current.failures.push({ tool: name, code })
      }
    }
  }

  if (current !== undefined) out.push(finish(current, session, fallback))
  return out
}

/** Aggregate observation counts for the journal and the status view. */
export interface ObservationSummary {
  readonly turns: number
  readonly failures: number
  readonly corrections: number
  readonly topTool?: string
  readonly meanSteps: number
}

/** Summarize observations without a model call. */
export function summarizeObservations(observations: readonly Observation[]): ObservationSummary {
  if (observations.length === 0) {
    return { turns: 0, failures: 0, corrections: 0, meanSteps: 0 }
  }
  const totals: Record<string, number> = {}
  let failures = 0
  let corrections = 0
  let steps = 0
  for (const observation of observations) {
    failures += observation.failures.length
    if (observation.corrected) corrections += 1
    steps += observation.steps
    for (const [name, count] of Object.entries(observation.tools)) {
      totals[name] = (totals[name] ?? 0) + count
    }
  }
  const top = Object.entries(totals).sort((left, right) => right[1] - left[1])[0]
  return {
    turns: observations.length,
    failures,
    corrections,
    meanSteps: Math.round((steps / observations.length) * 10) / 10,
    ...(top === undefined ? {} : { topTool: top[0] }),
  }
}
