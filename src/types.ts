/** Shared vocabulary for the fracture loop. No I/O lives here. */

/** One row of a Cordis composition: the unit a candidate harness is made of. */
export interface PresetRow {
  readonly id?: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: boolean | string
}

/** How a candidate is executed during a probe. */
export type ProbeMode = 'in-process' | 'out-of-process'

/** The four levers a candidate may pull, ordered by increasing enforcement. */
export type Lever = 'prompt' | 'skill' | 'script' | 'tool' | 'hook'

/** One candidate harness edit, as authored by the proposer subagent. */
export interface Candidate {
  readonly id: string
  readonly title: string
  /** Why this edit should help, tied to the diagnosis finding it answers. */
  readonly rationale: string
  /** Which diagnosis finding this edit answers. */
  readonly finding: string
  readonly lever: Lever
  /** Composition rows to insert above the current harness. */
  readonly rows: readonly PresetRow[]
  /** Optional deterministic check run in both probe workspaces. */
  readonly verify?: string
  /**
   * Prompt text the loop may apply to a running agent without a restart.
   *
   * Only prompt-level additions qualify: the loop cannot re-bind a live agent's
   * preset, so a row that is not a plain text addition has to be installed.
   */
  readonly prompt?: string
}

/** A single observed step of a probe run. */
export interface Step {
  readonly action: string
  readonly observation: string
}

/** The rendered trace of one probe run. */
export interface Trajectory {
  readonly steps: readonly Step[]
  readonly finalText: string
  readonly toolErrors: number
}

/** Per-tool-call statistics gathered across sessions. */
export interface ToolStat {
  readonly name: string
  readonly calls: number
  readonly failures: number
}

/** One ranked observation about the current harness. */
export interface Finding {
  readonly id: string
  readonly severity: 'high' | 'medium' | 'low'
  /** What was observed, in counts and names only. The proposer turns this into an edit. */
  readonly evidence: string
  /** The lever that most likely addresses this without over-reaching. */
  readonly lever: Lever
}

/** The complete diagnosis handed to the proposer. */
export interface Diagnosis {
  readonly sessions: number
  readonly events: number
  readonly toolStats: readonly ToolStat[]
  readonly findings: readonly Finding[]
  readonly feedback: { readonly positive: number; readonly negative: number }
  readonly tokens: { readonly input: number; readonly output: number } | null
  readonly generatedAt: string
}

/** Structural view of a stored session event; the real union is a superset. */
export interface RawEvent {
  readonly type: string
  /** Unix epoch milliseconds, when the log carries one. */
  readonly time?: number
  readonly data?: Record<string, unknown>
}

/** Options that tune the diagnosis rules. */
export interface DiagnoseOptions {
  /** A tool with at least this many calls is eligible for a failure finding. */
  readonly minCalls: number
  /** Failure ratio at or above this value raises a finding. */
  readonly failureRatio: number
  /** Same-path reads in one session at or above this count raise a finding. */
  readonly rereadThreshold: number
  /** Denied approvals at or above this count raise a finding. */
  readonly denialThreshold: number
}

/** Defaults chosen so a single unlucky failure never raises a finding. */
export const DEFAULT_DIAGNOSE_OPTIONS: DiagnoseOptions = {
  minCalls: 3,
  failureRatio: 0.3,
  rereadThreshold: 3,
  denialThreshold: 2,
}

/** The verdict of comparing two probe runs. */
export type Verdict = 'improved' | 'regressed' | 'no-change' | 'needs-review'

/** One side of a probe. */
export interface ProbeSide {
  readonly passed: boolean | null
  readonly trajectory: Trajectory
  /**
   * Input tokens of the first step, when the run reported usage.
   *
   * This is the number the loop spends before doing any work: the instruction
   * set and the first user turn. Absent when the provider gave no sample, which
   * is not the same as zero.
   */
  readonly promptTokens?: number
  readonly error?: string
}

/**
 * A rubric score attached to a probe.
 *
 * Deliberately loose here: `judge.ts` owns the shape, and typing it twice would
 * let the two drift.
 */
export interface ProbeJudge {
  readonly score?: { readonly baseline: number; readonly changed: number; readonly verdict: Verdict; readonly reason: string }
  readonly raw: string
  readonly error?: string
  readonly childId?: string
}

/** The persisted result of one probe. */
export interface ProbeResult {
  readonly runId: string
  readonly candidateId: string
  readonly mode: ProbeMode
  readonly task: string
  readonly verdict: Verdict
  readonly reason: string
  readonly baseline: ProbeSide
  readonly changed: ProbeSide
  /** Present when the judge ran; absent when the flag is off or a check decided. */
  readonly judge?: ProbeJudge
  readonly startedAt: string
  readonly finishedAt: string
}
