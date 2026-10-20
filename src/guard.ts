/**
 * Candidate guards.
 *
 * The loop edits the harness that is running it, so some rows must stay out of
 * reach no matter what a diagnosis suggests. These checks run before a candidate
 * is stored, probed, or adopted: refusing early keeps a bad row out of the
 * candidate directory entirely.
 */

import type { Candidate, PresetRow } from './types.js'

/** Row names the loop may never propose, probe, or adopt. */
export const PROTECTED_ROWS: readonly string[] = [
  'dsh-user-approval',
  'dsh-sandbox-policy',
  'dsh-plugin-manager',
  'plugin_manager',
  'dsh-fracture',
]

/** Substrings that mark a row as part of the loop's own control surface. */
const PROTECTED_FRAGMENTS = ['approval', 'sandbox', 'plugin-manager', 'pluginManager', 'fracture']

/** Why a row is protected, or undefined when it is free to edit. */
export function protectionOf(row: PresetRow): string | undefined {
  const haystack = `${row.id ?? ''} ${row.name}`.toLowerCase()
  for (const name of PROTECTED_ROWS) {
    if (haystack.includes(name.toLowerCase())) return name
  }
  for (const fragment of PROTECTED_FRAGMENTS) {
    if (haystack.includes(fragment.toLowerCase())) return fragment
  }
  return undefined
}

/**
 * Validate a candidate before it is written or executed.
 * @param candidate - parsed candidate.
 * @returns a list of human-readable problems; empty means acceptable.
 */
export function candidateProblems(candidate: Candidate): string[] {
  const problems: string[] = []
  if (candidate.rows.length === 0) problems.push('the candidate has no composition rows, so it cannot change anything')
  if (candidate.rows.length > 8) problems.push(`the candidate inserts ${String(candidate.rows.length)} rows; keep a candidate small enough to attribute an effect`)
  for (const row of candidate.rows) {
    const protect = protectionOf(row)
    if (protect !== undefined) {
      problems.push(`row ${JSON.stringify(row.name)} touches the protected surface "${protect}" (approval, sandbox, the plugin manager, or this loop itself)`)
    }
  }
  if (candidate.verify !== undefined && candidate.verify.length > 500) problems.push('the verify command is too long to review')
  return problems
}
