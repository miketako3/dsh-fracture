/**
 * Child-agent execution shared by propose and probe.
 *
 * A child started here is caller-delivered: it never posts a completion notice
 * into the parent conversation, so the tool that started it decides how to
 * present the result. Teardown always runs, including when the result promise
 * rejects.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ProbeSide, Trajectory } from './types.js'
import { readSessionEvents } from './sessions.js'
import { trajectoryFromSession } from './trajectory.js'

/** A trajectory with nothing in it, used whenever startup fails. */
export const EMPTY_TRAJECTORY: Trajectory = { steps: [], finalText: '', toolErrors: 0 }

/** Turn an unknown throwable into a message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Model-visible text of a content block array. */
export function blockText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('\n')
}

/** Read a persisted child session into a trajectory, tolerating absent persistence. */
export async function sessionTrajectory(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<Trajectory | undefined> {
  const events = await readSessionEvents(ctx, sessionId, signal)
  return events === undefined ? undefined : trajectoryFromSession(events)
}

/** One child run's outcome. */
export interface ChildRun {
  readonly side: ProbeSide
  readonly childId?: string
}

type Started = { readonly ok: true; readonly activation: SubagentActivation } | { readonly ok: false; readonly error: string }

async function startChild(
  ctx: Context,
  provider: string,
  parent: Agent,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  agentPreset: string | undefined,
): Promise<Started> {
  try {
    const activation = await ctx.subagents.startActivation({
      provider,
      label: agentPreset === undefined ? 'self-harness' : `self-harness ${agentPreset}`,
      request: {
        parent,
        prompt: [{ type: 'text', text: prompt }],
        cwd,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
      signal,
      delivery: 'caller',
    })
    return { ok: true, activation }
  } catch (error) {
    return { ok: false, error: `could not start the child agent: ${messageOf(error)}` }
  }
}

/**
 * Run one child to completion.
 * @param ctx - host context providing `subagents` and optional persistence.
 * @param provider - registered subagent provider name.
 * @param parent - the agent that owns the child.
 * @param prompt - exact user message for the child.
 * @param cwd - child working directory.
 * @param signal - cancellation; also disposes the child.
 * @param agentPreset - optional preset id, which the child joins instead of the parent's.
 * @returns the child's outcome and identity; disposal has already completed.
 */
export async function runChild(
  ctx: Context,
  provider: string,
  parent: Agent,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  agentPreset?: string,
): Promise<ChildRun> {
  const started = await startChild(ctx, provider, parent, prompt, cwd, signal, agentPreset)
  if (!started.ok) return { side: { passed: null, trajectory: EMPTY_TRAJECTORY, error: started.error } }

  const { activation } = started
  try {
    const result = await activation.result
    const finalText = blockText(result.output)
    const fromLog = await sessionTrajectory(ctx, activation.childId, signal)
    const trajectory = fromLog ?? { steps: [], finalText, toolErrors: 0 }
    return {
      side: {
        passed: null,
        trajectory: trajectory.finalText === '' && finalText !== '' ? { ...trajectory, finalText } : trajectory,
        ...(result.stopReason === 'completed' ? {} : { error: `child stopped: ${result.stopReason}` }),
      },
      childId: activation.childId,
    }
  } catch (error) {
    return { side: { passed: null, trajectory: EMPTY_TRAJECTORY, error: messageOf(error) }, childId: activation.childId }
  } finally {
    // The child never outlives the call that started it, even on cancellation.
    await activation.dispose().catch(() => undefined)
  }
}
