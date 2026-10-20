/**
 * Rubric judgement: a second model reads both trajectories and scores them.
 *
 * This exists because a deterministic check is the exception, not the rule. Most
 * tasks the loop would like to improve have no command that answers "did the
 * harness do better"; without a read, every such candidate parks as
 * `needs-review` and the loop stops improving.
 *
 * It is off by default and it never overrides a check. A rubric is one model's
 * opinion of two texts, so it is the weakest evidence in the loop, and the
 * report says so.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProbeSide } from './types.js'
import { runChild } from './child.js'
import { renderTrajectory } from './trajectory.js'

/** A scored comparison of the two probe sides. */
export interface RubricScore {
  readonly baseline: number
  readonly changed: number
  /** Derived from the two scores, not taken from the model's own summary. */
  readonly verdict: 'improved' | 'regressed' | 'no-change'
  readonly reason: string
}

/** What one judgement produced. */
export interface JudgeOutcome {
  readonly score?: RubricScore
  /** The child's raw reply, kept so a human can check the parse. */
  readonly raw: string
  readonly error?: string
  readonly childId?: string
}

const MAX_TRAJECTORY = 6_000

function clipTrajectory(side: ProbeSide): string {
  if (side.error !== undefined) return `(the run failed: ${side.error})`
  const text = `${renderTrajectory(side.trajectory)}\n\n[FINAL]\n${side.trajectory.finalText}`
  return text.length <= MAX_TRAJECTORY ? text : `${text.slice(0, MAX_TRAJECTORY)}\n… [truncated]`
}

/**
 * The exact prompt for the judge child.
 * @param task - the task both sides were given.
 * @param baseline - the run on the current harness.
 * @param changed - the run with the candidate.
 * @returns the prompt text.
 */
export function buildJudgePrompt(task: string, baseline: ProbeSide, changed: ProbeSide): string {
  return [
    'You are the judge in a self-improvement loop for a coding agent harness.',
    'Two runs of the same task are below: one on the current harness, one with a candidate change.',
    'You did not write either of them and you do not know which change was made.',
    '',
    'Score each run from 1 to 5 on how well it completed the task:',
    '',
    '5 = the task is done and the work is verifiable from the transcript',
    '4 = the task is done, with a step a reader would have to trust',
    '3 = partly done, or done with a workaround that hides a problem',
    '2 = the run stopped in a state that needs a human to continue',
    '1 = the run failed, looped, or produced something unrelated',
    '',
    'Judge only what the transcript shows. A confident summary is not evidence.',
    'Then say which run is better and why, in one sentence.',
    '',
    'Reply with JSON and nothing else:',
    '',
    '{"baseline": 1, "changed": 1, "reason": "one sentence"}',
    '',
    '## Task',
    '',
    '```text',
    task.trim(),
    '```',
    '',
    '## Run A',
    '',
    '```text',
    clipTrajectory(baseline),
    '```',
    '',
    '## Run B',
    '',
    '```text',
    clipTrajectory(changed),
    '```',
    '',
  ].join('\n')
}

/** Read the first JSON object in a reply, tolerating code fences and prose around it. */
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

function score(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded >= 1 && rounded <= 5 ? rounded : undefined
}

/**
 * Turn a judge reply into a score.
 *
 * The verdict comes from the numbers, not from the model's prose: a reply that
 * says "improved" while scoring the candidate lower is incoherent, and the
 * numbers are the part that can be checked.
 * @param reply - the child's text.
 * @returns the score, or undefined when the reply is not usable.
 */
export function parseJudge(reply: string): RubricScore | undefined {
  const object = firstObject(reply)
  if (object === undefined) return undefined
  const baseline = score(object['baseline'])
  const changed = score(object['changed'])
  if (baseline === undefined || changed === undefined) return undefined
  const reason = typeof object['reason'] === 'string' ? object['reason'].trim() : ''
  return {
    baseline,
    changed,
    verdict: changed > baseline ? 'improved' : changed < baseline ? 'regressed' : 'no-change',
    reason: reason === '' ? 'the judge gave no reason' : reason,
  }
}

/** Everything a judgement needs from the host. */
export interface JudgeRequest {
  readonly ctx: Context
  readonly provider: string
  readonly parent: Agent
  readonly task: string
  readonly baseline: ProbeSide
  readonly changed: ProbeSide
  readonly cwd: string
  readonly signal: AbortSignal
}

/**
 * Run one judgement.
 * @param request - host, provider, task, and both sides.
 * @returns the parsed score, or an outcome carrying why it could not be read.
 */
export async function judge(request: JudgeRequest): Promise<JudgeOutcome> {
  const prompt = buildJudgePrompt(request.task, request.baseline, request.changed)
  const run = await runChild(request.ctx, request.provider, request.parent, prompt, request.cwd, request.signal)
  const raw = run.side.trajectory.finalText.trim()
  const childId = run.childId
  if (run.side.error !== undefined && raw === '') {
    return { raw: '', error: run.side.error, ...(childId === undefined ? {} : { childId }) }
  }
  const parsed = parseJudge(raw)
  if (parsed === undefined) {
    return { raw, error: 'the reply did not contain a usable score', ...(childId === undefined ? {} : { childId }) }
  }
  return { score: parsed, raw, ...(childId === undefined ? {} : { childId }) }
}

/** Render the judge result for a report. */
export function renderJudge(outcome: JudgeOutcome): string {
  if (outcome.error !== undefined) return `_The judge did not produce a score: ${outcome.error}._`
  const scored = outcome.score
  if (scored === undefined) return '_No score._'
  return [
    '| side | score |',
    '| --- | --- |',
    `| baseline | ${String(scored.baseline)}/5 |`,
    `| changed | ${String(scored.changed)}/5 |`,
    '',
    `_${scored.reason}_`,
  ].join('\n')
}
