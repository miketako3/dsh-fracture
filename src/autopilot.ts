/**
 * The autonomous part: observation, memory, and skill distillation, driven by
 * session events rather than by a model calling a tool.
 *
 * Everything here is deterministic. The loop may later run a summarizer
 * subagent for prose, but the facts it acts on come from counts, so a session
 * that never calls a model still improves its own memory.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from './store.js'
import type { Store } from './store.js'
import { observationsFromSession, summarizeObservations } from './observe.js'
import type { Observation } from './observe.js'
import { appendObservations, countObservations, journal, memoryIndex, readObservations, writeDigest } from './memory.js'
import type { MemoryIndex } from './memory.js'
import { DEFAULT_DISTILL, listSkills, renderSkill, skillCandidates, writeSkill } from './skills.js'
import type { StoredSkill } from './skills.js'
import { EMPTY_STATE, recordTurn } from './policy.js'
import type { LoopState } from './policy.js'
import type { RawEvent } from './types.js'

/** Tuning for the automatic tiers. */
export interface AutopilotConfig {
  /** Observations between digest rewrites. */
  readonly digestEvery: number
  /** Successful repetitions before a procedure becomes a skill. */
  readonly distillMinRepeats: number
  /** Skill candidates written per pass. */
  readonly maxSkillsPerPass: number
}

/** Defaults: a digest every 20 turns, a skill after three clean repetitions. */
export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  digestEvery: 20,
  distillMinRepeats: DEFAULT_DISTILL.minRepeats,
  maxSkillsPerPass: 3,
}

/** Persisted per-session progress, so a restart does not re-count turns. */
interface Progress {
  readonly seen: Record<string, number>
  readonly state: LoopState
  /** Observation count at the last digest rewrite. */
  readonly digestedAt: number
}

/** What one pass changed, for the journal and the caller's notice. */
export interface PassResult {
  readonly observations: number
  readonly digested: boolean
  readonly skillsWritten: readonly string[]
}

const NOTHING: PassResult = { observations: 0, digested: false, skillsWritten: [] }

/**
 * Owns the loop's state and its view of the store.
 *
 * One instance per plugin; the prompt section reads {@link index} synchronously
 * while the async work below keeps it current.
 */
export class Autopilot {
  readonly #store: Store
  readonly #config: AutopilotConfig
  readonly #now: () => number
  #progress: Progress = { seen: {}, state: EMPTY_STATE, digestedAt: 0 }
  #index: MemoryIndex = { digestHeadings: [], skillNames: [], observations: 0 }
  #skills: StoredSkill[] = []
  #loaded = false

  constructor(store: Store, config: Partial<AutopilotConfig> = {}, now: () => number = Date.now) {
    this.#store = store
    this.#config = { ...DEFAULT_AUTOPILOT, ...config }
    this.#now = now
  }

  /** Current index for the prompt section; safe to call before {@link load}. */
  get index(): MemoryIndex {
    return this.#index
  }

  /** Distilled skills currently on disk. */
  get skills(): readonly StoredSkill[] {
    return this.#skills
  }

  /** Current loop state. */
  get state(): LoopState {
    return this.#progress.state
  }

  /** Read persisted progress and the store's current contents. */
  async load(): Promise<void> {
    this.#progress = await this.#readProgress()
    this.#skills = await listSkills(this.#store)
    this.#index = await memoryIndex(this.#store, this.#skills)
    this.#loaded = true
  }

  /**
   * Handle one event on a live session.
   *
   * Only a closed turn does work: appending a partial turn on every event would
   * multiply the log and produce skills from incomplete evidence.
   * @param session - session id.
   * @param events - events seen so far for that session, in log order.
   * @returns what the pass changed.
   */
  async observe(session: string, events: readonly RawEvent[]): Promise<PassResult> {
    if (!this.#loaded) await this.load()
    const last = events.at(-1)
    if (last?.type !== 'turn/end') return NOTHING

    const all = observationsFromSession(session, events, this.#now())
    const seen = this.#progress.seen[session] ?? 0
    const fresh = all.filter(observation => observation.turn > seen)
    this.#progress = {
      ...this.#progress,
      seen: { ...this.#progress.seen, [session]: all.at(-1)?.turn ?? seen },
      state: recordTurn(this.#progress.state),
    }

    if (fresh.length === 0) {
      await this.#save()
      return NOTHING
    }
    await appendObservations(this.#store, fresh)

    const count = await countObservations(this.#store)
    const digested = count - this.#progress.digestedAt >= this.#config.digestEvery
    if (digested) {
      await this.#writeDigest()
      this.#progress = { ...this.#progress, digestedAt: count }
    }
    const skillsWritten = await this.#distill()

    await this.#refresh()
    await this.#save()
    return { observations: fresh.length, digested, skillsWritten }
  }

  /** Force a digest rewrite, for the manual tool and for session close. */
  async refreshDigest(): Promise<void> {
    if (!this.#loaded) await this.load()
    await this.#writeDigest()
    await this.#refresh()
  }

  /** Rewrite the digest from observations. Deterministic, so it is safe to call often. */
  async #writeDigest(): Promise<void> {
    const observations = await readObservations(this.#store, 200)
    const summary = summarizeObservations(observations)
    const tasks = new Map<string, number>()
    const failures = new Map<string, number>()
    const recipes = new Map<string, number>()
    for (const observation of observations) {
      const task = observation.task.trim()
      if (task !== '') tasks.set(task, (tasks.get(task) ?? 0) + 1)
      for (const failure of observation.failures) {
        const key = `${failure.tool} ${failure.code}`
        failures.set(key, (failures.get(key) ?? 0) + 1)
      }
      const recipe = observation.sequence.join(' > ')
      if (recipe !== '') recipes.set(recipe, (recipes.get(recipe) ?? 0) + 1)
    }

    const lines: string[] = [
      '# Memory',
      '',
      `_Updated ${new Date(this.#now()).toISOString()} from ${String(summary.turns)} observed turns._`,
      '',
      '## Working on',
      '',
      ...top(tasks, 5).map(([task, count]) => `- ${task} (${String(count)}x)`),
      '',
      '## What fails',
      '',
      ...(failures.size === 0 ? ['- nothing recorded'] : top(failures, 5).map(([key, count]) => `- ${key} (${String(count)}x)`)),
      '',
      '## Procedures',
      '',
      ...(recipes.size === 0 ? ['- nothing recorded'] : top(recipes, 5).map(([recipe, count]) => `- ${recipe} (${String(count)}x)`)),
      '',
    ]
    await writeDigest(this.#store, lines.join('\n'))
    await journal(this.#store, `memory digest rewritten from ${String(summary.turns)} turns`)
  }

  /** Turn repeated clean procedures into skills. */
  async #distill(): Promise<string[]> {
    const observations = await readObservations(this.#store, 200)
    const candidates = skillCandidates(observations, { minRepeats: this.#config.distillMinRepeats })
    const written: string[] = []
    for (const candidate of candidates.slice(0, this.#config.maxSkillsPerPass)) {
      const path = await writeSkill(this.#store, candidate.slug, renderSkill(candidate))
      if (path === undefined) continue
      written.push(candidate.slug)
      await journal(this.#store, `distilled skill ${candidate.slug} from ${String(candidate.count)} clean repetitions`)
    }
    return written
  }

  /** Re-read the store so {@link index} reflects what was just written. */
  async #refresh(): Promise<void> {
    this.#skills = await listSkills(this.#store)
    this.#index = await memoryIndex(this.#store, this.#skills)
  }

  async #readProgress(): Promise<Progress> {
    try {
      const raw = await readFile(this.#statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Progress>
      return {
        seen: typeof parsed.seen === 'object' && parsed.seen !== null ? parsed.seen : {},
        state: { ...EMPTY_STATE, ...(parsed.state ?? {}) },
        digestedAt: typeof parsed.digestedAt === 'number' ? parsed.digestedAt : 0,
      }
    } catch {
      return { seen: {}, state: EMPTY_STATE, digestedAt: 0 }
    }
  }

  async #save(): Promise<void> {
    await writeJson(this.#statePath, this.#progress)
  }

  get #statePath(): string {
    return join(this.#store.baseDir, 'state.json')
  }
}

function top(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit)
}

/** Observations are re-exported for callers that render the status view. */
export type { Observation }
