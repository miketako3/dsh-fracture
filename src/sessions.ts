/**
 * Session reading.
 *
 * Two services can answer the same question: `ctx.sessionQuery` (the replay
 * validated reader) and `ctx.sessionPersistence` (the storage backend). A
 * plugin that only installed one of them should still work, so this module
 * prefers the query service and falls back to persistence.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type { RawEvent } from './types.js'

/** One session's identity plus its raw event log. */
export interface SessionSlice {
  readonly id: SessionId
  readonly cwd?: string
  readonly events: RawEvent[]
}

/** Newest-first session ids, capped at `limit`. */
export async function listSessionIds(ctx: Context, limit: number, signal: AbortSignal): Promise<SessionId[]> {
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    const records = await query.listSessions(signal)
    return records.slice(0, limit).map(record => record.header.id)
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const snapshots = await persistence.list({ signal })
    return [...snapshots]
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
      .slice(0, limit)
      .map(snapshot => snapshot.header.id)
  }
  throw new Error('no session reader is installed: enable dsh-session-query or dsh-session-persistence')
}

/** Read one session's events, or undefined when the id cannot be read. */
export async function readSessionEvents(ctx: Context, id: SessionId, signal: AbortSignal): Promise<RawEvent[] | undefined> {
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      const snapshot = await query.readSession(id)
      return snapshot.events as unknown as RawEvent[]
    } catch {
      return undefined
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  try {
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const { events } = await handle.read(0, undefined, { signal })
      return events as unknown as RawEvent[]
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Read several sessions, newest first, skipping unreadable ones. */
export async function loadSessions(ctx: Context, limit: number, signal: AbortSignal): Promise<SessionSlice[]> {
  const ids = await listSessionIds(ctx, limit, signal)
  const slices: SessionSlice[] = []
  for (const id of ids) {
    const events = await readSessionEvents(ctx, id, signal)
    if (events !== undefined) slices.push({ id, events })
  }
  return slices
}
