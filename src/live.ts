/**
 * Live wiring: what the loop adds to a running agent, without a restart.
 *
 * Two contributions, both hosted by the agent's own scope:
 *
 * - a system-prompt section carrying the memory and skill index;
 * - the distilled skills, registered so the model can load them.
 *
 * Both are Cordis effects on an injected scope, so disposing the scope removes
 * them. Nothing here sets `complete: true` (which would hide the rest of the
 * prompt) and nothing touches `toolOrder` (which throws once a listed tool is
 * missing).
 */

import type { MemoryIndex } from './memory.js'

/** A skill as the prompt/tool layer wants it. */
export interface RuntimeSkill {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly whenToUse?: string
}

/** Minimal shape of the scoped services this module needs. */
export interface LiveScope {
  systemPrompt: {
    section(spec: {
      readonly name: string
      readonly order: number
      readonly text: () => string
      readonly interpolate?: boolean
    }): () => void
    getSectionOrder?(name: string): number
  }
  skills?: {
    register(skill: RuntimeSkill & { readonly source: string }): () => void
  }
}

/** Minimal shape of an agent, as much as the live layer needs. */
export interface LiveAgent {
  readonly ctx: {
    inject(services: readonly string[], callback: (scope: LiveScope) => void): { dispose(): Promise<void> }
  }
}

/** Section name; stable so a remount replaces rather than duplicates. */
export const SECTION_NAME = 'self-harness:memory'

/** Order used when the host does not publish one for our slot. */
const FALLBACK_ORDER = 8_500

/** Render the index shown to the model. Pure, bounded, and never throws on empty input. */
export function renderIndex(index: MemoryIndex, maxSkills = 8): string {
  const parts: string[] = []
  if (index.digestHeadings.length > 0) parts.push(`- memory digest sections: ${index.digestHeadings.join(', ')}`)
  if (index.skillNames.length > 0) {
    const shown = index.skillNames.slice(0, maxSkills)
    const more = index.skillNames.length - shown.length
    parts.push(`- distilled skills: ${shown.join(', ')}${more > 0 ? ` (+${String(more)} more)` : ''}`)
  }
  if (index.observations > 0) parts.push(`- turns observed: ${String(index.observations)}`)
  if (parts.length === 0) return ''

  return [
    '## What this harness has learned',
    '',
    '`dsh-self-harness` accumulates this on its own from past sessions. Read it before re-deriving it.',
    '',
    ...parts,
    '',
    'Use `memory_search` for detail, and the `skill` tool to load a procedure in full.',
  ].join('\n')
}

/** Handle for one agent's live contributions. */
export interface LiveHandle {
  /** Re-register the given skills, replacing whatever this handle registered before. */
  reconcile(skills: readonly RuntimeSkill[]): void
  /** Remove everything this handle added. Resolves when the injected scope is disposed. */
  dispose(): Promise<void>
}

/**
 * Attach the memory section and the distilled skills to one agent.
 * @param agent - the agent to extend.
 * @param readIndex - synchronous snapshot supplier; called on every prompt assembly.
 * @returns a handle that reconciles skills and disposes both contributions.
 */
export function installLive(agent: LiveAgent, readIndex: () => MemoryIndex): LiveHandle {
  let registered = new Map<string, () => void>()
  let skillScope: LiveScope | undefined
  let indexReads = 0

  const section = agent.ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.section({
      name: SECTION_NAME,
      // Just above the tool descriptions, below the harness source block.
      order: (scope.systemPrompt.getSectionOrder?.('HARNESS_SOURCE') ?? FALLBACK_ORDER + 1_500) - 100,
      // Dynamic: assembly calls this every step, so the index follows the store.
      text: () => {
        indexReads += 1
        try {
          return renderIndex(readIndex())
        } catch {
          return ''
        }
      },
      // The body is prose that may contain braces; interpolation is strict and throws.
      interpolate: false,
    })
  })

  const skills = agent.ctx.inject(['skills'], scope => {
    skillScope = scope
  })

  return {
    reconcile(next: readonly RuntimeSkill[]): void {
      if (skillScope?.skills === undefined) return
      const wanted = new Map(next.map(skill => [skill.name, skill]))
      for (const [name, dispose] of registered) {
        if (wanted.has(name)) continue
        dispose()
        registered.delete(name)
      }
      for (const [name, skill] of wanted) {
        if (registered.has(name)) continue
        try {
          registered.set(name, skillScope.skills.register({ ...skill, source: 'runtime' }))
        } catch {
          // An invalid name or description is the caller's bug; skip it, never throw into the loop.
        }
      }
    },
    async dispose(): Promise<void> {
      registered = new Map()
      skillScope = undefined
      await Promise.allSettled([section.dispose(), skills.dispose()])
    },
  }
}