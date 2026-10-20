/**
 * Applying a candidate to a running agent, and taking it back.
 *
 * A live agent's preset cannot be re-bound, so an automatic apply cannot be a
 * row insertion. What it can be is a prompt section registered on the agent's
 * own scope: it takes effect on the next assembly, and disposing the scope
 * removes it completely. That is the only shape of change this module applies.
 *
 * Anything that needs a row the loader owns, or any code at all, stays a
 * bundle for a human to install.
 */

import { installSection } from './live.js'
import type { LiveAgent, Mounted } from './live.js'
import type { Candidate } from './types.js'

/** A prompt addendum that is live on an agent. */
export interface Override {
  readonly candidateId: string
  /** Section name, unique per candidate so a re-apply replaces rather than stacks. */
  readonly sectionName: string
  readonly text: string
  /** Order used for the section; just above the memory index. */
  readonly order: number
}

/** Section order for candidate addenda. Sits just above the memory index. */
export const OVERRIDE_ORDER = 9_950

/** Whether a candidate can be applied live, and why not when it cannot. */
export function applyability(candidate: Candidate): { ok: true } | { ok: false; reason: string } {
  if (candidate.prompt === undefined) {
    return { ok: false, reason: 'the candidate has no `prompt` text, so it can only be installed as a bundle' }
  }
  if (candidate.rows.length > 0) {
    return { ok: false, reason: 'the candidate inserts rows that only the loader can apply' }
  }
  return { ok: true }
}

/** Section name for a candidate; names are unique per id. */
export function sectionNameFor(candidateId: string): string {
  const safe = candidateId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return `fracture:candidate:${safe}`
}

/**
 * Build the live override for a candidate.
 * @param candidate - a candidate carrying `prompt` text.
 * @returns the override, or undefined when the candidate is not applyable live.
 */
export function overrideOf(candidate: Candidate): Override | undefined {
  if (!applyability(candidate).ok) return undefined
  return {
    candidateId: candidate.id,
    sectionName: sectionNameFor(candidate.id),
    text: candidate.prompt ?? '',
    order: OVERRIDE_ORDER,
  }
}

/**
 * Register an override on one agent.
 * @param agent - live agent.
 * @param override - what to add.
 * @returns a handle whose dispose removes the section.
 */
export function applyOverride(agent: LiveAgent, override: Override): Applied {
  return {
    override,
    handle: installSection(agent, { name: override.sectionName, order: override.order, text: override.text }),
  }
}

/** A handle plus the override it represents, for the revert path. */
export interface Applied {
  readonly override: Override
  readonly handle: Mounted
}

/** Revert an applied override, tolerating a scope that is already gone. */
export async function revertOverride(applied: Applied): Promise<void> {
  await applied.handle.dispose()
}
