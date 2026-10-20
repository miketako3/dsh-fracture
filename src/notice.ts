/**
 * Telling the user what the loop did, inside the session they are already in.
 *
 * The message is injected as context with a producer-specific source kind, so
 * the UI renders it as a collapsed notice rather than as something the human
 * typed, and injecting it does not start a turn. That distinction matters: a
 * loop that appears to prompt itself is a loop that looks like a user.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fracture': {
      readonly kind: 'fracture'
      /** A one-off account, shown without expanding the row. */
      readonly form: 'notice'
      /** One line, bounded by the host's context summary limit. */
      readonly summary: string
    }
  }
}

/** The part of an agent a notice needs. */
export interface NoticeAgent {
  inject(message: UserMessage): void
}

/**
 * Build a notice message.
 * @param text - full body, shown when the row is expanded.
 * @param summary - one-line account; defaults to the first line of the body.
 * @returns an injected-context user message whose source is this plugin.
 */
export function noticeMessage(text: string, summary?: string): UserMessage {
  const firstLine = text.split('\n').find(line => line.trim() !== '') ?? text
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'fracture',
      form: 'notice',
      summary: boundContextSummary((summary ?? firstLine).trim()),
    },
  })
}

/**
 * Deliver a notice, tolerating an agent that cannot take one.
 *
 * A missing seam must never break the loop: the journal is the record of
 * record, and this is the convenience layer on top of it.
 * @param agent - live agent, when one is available.
 * @param text - what to say.
 * @param summary - optional one-line account.
 * @returns whether the notice was injected.
 */
export function notify(agent: NoticeAgent | undefined, text: string, summary?: string): boolean {
  if (agent === undefined) return false
  try {
    agent.inject(noticeMessage(text, summary))
    return true
  } catch {
    return false
  }
}
