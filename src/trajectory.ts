/**
 * Trajectory rendering.
 *
 * The `[ACTION]` / `[OBSERVATION]` grammar is borrowed from Harness² (Google
 * Research, Apache-2.0) as a format idea, not as code: it is small enough to
 * compare two runs by eye and by diff, which is the whole point of a probe.
 */

import type { RawEvent, Step, Trajectory } from './types.js'

const MAX_ACTION = 240
const MAX_OBSERVATION = 1_200

function clip(text: string, limit: number): string {
  const flat = text.replace(/\r/g, '')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}… [${String(flat.length - limit)} chars omitted]`
}

/** Describe tool input without dumping large payloads. */
function describeInput(input: unknown): string {
  if (typeof input === 'string') return clip(input, MAX_ACTION)
  try {
    return clip(JSON.stringify(input), MAX_ACTION)
  } catch {
    return '(unserializable)'
  }
}

/** Extract model-visible text from a content block array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('\n')
}

/** Fold stored session events into a trajectory. */
export function trajectoryFromSession(events: readonly RawEvent[]): Trajectory {
  const steps: Step[] = []
  const pending = new Map<string, string>()
  let finalText = ''
  let toolErrors = 0

  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'tool/call') {
      const callId = typeof data['callId'] === 'string' ? data['callId'] : ''
      const name = typeof data['name'] === 'string' ? data['name'] : 'tool'
      const action = `${name} ${describeInput(parseArguments(data['arguments']))}`
      if (callId !== '') pending.set(callId, action)
      else steps.push({ action, observation: '(no result recorded)' })
      continue
    }
    if (event.type === 'tool/result') {
      const callId = typeof data['callId'] === 'string' ? data['callId'] : atPath(data, 'message', 'toolCallId')
      const action = (typeof callId === 'string' ? pending.get(callId) : undefined) ?? 'tool'
      if (typeof callId === 'string') pending.delete(callId)
      const failed = data['error'] !== undefined && data['error'] !== null
      const isError = atPath(data, 'message', 'isError') === true
      if (failed || isError) toolErrors += 1
      const body = contentText(atPath(data, 'message', 'content')) || (failed ? 'error' : '')
      const observation = `${isError || failed ? '[error] ' : ''}${body === '' ? '(empty result)' : clip(body, MAX_OBSERVATION)}`
      steps.push({ action, observation })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText(atPath(data, 'message', 'content')) || contentText(data['content'])
      if (text.trim() !== '') finalText = text
    }
  }

  for (const action of pending.values()) steps.push({ action, observation: '(no result recorded)' })
  return { steps, finalText, toolErrors }
}

/** Fold a `dsh --json` event stream into a trajectory. */
export function trajectoryFromHeadless(events: readonly unknown[]): Trajectory {
  const steps: Step[] = []
  const pending = new Map<string, string>()
  let finalText = ''
  let toolErrors = 0

  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    const kind = record['type']
    if (kind === 'tool_call') {
      const callId = typeof record['callId'] === 'string' ? record['callId'] : ''
      const tool = typeof record['tool'] === 'string' ? record['tool'] : 'tool'
      const action = `${tool} ${describeInput(record['input'])}`
      if (callId !== '') pending.set(callId, action)
      else steps.push({ action, observation: '(no result recorded)' })
      continue
    }
    if (kind === 'tool_result') {
      const callId = typeof record['callId'] === 'string' ? record['callId'] : ''
      const action = pending.get(callId) ?? 'tool'
      pending.delete(callId)
      const status = record['status']
      const failed = status === 'error'
      if (failed) toolErrors += 1
      const body = typeof record['result'] === 'string' ? record['result'] : ''
      steps.push({ action, observation: `${failed ? '[error] ' : ''}${body === '' ? '(empty result)' : clip(body, MAX_OBSERVATION)}` })
      continue
    }
    if (kind === 'text' && typeof record['text'] === 'string') finalText = record['text']
    if (kind === 'final' && typeof record['text'] === 'string') finalText = record['text']
  }

  for (const action of pending.values()) steps.push({ action, observation: '(no result recorded)' })
  return { steps, finalText, toolErrors }
}

/** Render a trajectory as the shared text grammar. */
export function renderTrajectory(trajectory: Trajectory): string {
  if (trajectory.steps.length === 0) return '_(no tool activity)_'
  return trajectory.steps
    .map(step => `[ACTION] ${step.action}\n[OBSERVATION]\n${step.observation}`)
    .join('\n\n')
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function atPath(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
