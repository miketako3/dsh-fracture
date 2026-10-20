/**
 * dsh-fracture: let a DSH agent improve its own harness.
 *
 * The loop is diagnose → propose → probe → adopt. Each step is a tool the model
 * calls itself, and every artifact the loop produces is a file the user can
 * read, diff, and delete. Nothing here edits a running profile behind the
 * user's back: adoption produces a bundle, and installing that bundle stays a
 * human-approved action.
 *
 * @module dsh-fracture
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { adopt, latestProbe } from './adopt.js'
import { applyability, applyOverride, overrideOf, revertOverride } from './apply.js'
import type { Applied } from './apply.js'
import { metricsFrom } from './metrics.js'
import { Autopilot } from './autopilot.js'
import { installLive } from './live.js'
import type { LiveAgent, LiveHandle } from './live.js'
import { journal, readObservations, searchMemory } from './memory.js'
import { notify } from './notice.js'
import { DEFAULT_POLICY, tierAllowed } from './policy.js'
import type { Autonomy, PolicyConfig } from './policy.js'
import { pickTask, shouldAutoLoop } from './autoloop.js'
import type { RawEvent } from './types.js'
import { diagnose } from './diagnose.js'
import { candidateProblems } from './guard.js'
import { propose } from './propose.js'
import { runChild } from './child.js'
import { buildCriteriaPrompt, parseCriteria, renderCriteria } from './criteria.js'
import { runProbe } from './probe.js'
import { loadSessions } from './sessions.js'
import { Store, timestamp } from './store.js'
import type { Candidate, Diagnosis } from './types.js'

export const name = 'fracture'

/** The tools registry is the only hard dependency; session and subagent services are checked at use. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Where candidates, runs, and lessons live. Relative paths resolve against the process directory. */
  baseDir: string
  /** Registered subagent provider used for proposer and in-process probe children. */
  provider: string
  /** `dsh` executable used for out-of-process probes. */
  dshCommand: string
  /** Profile an out-of-process probe launches. */
  profile: string
  /** Wall-clock cap for one child run or one out-of-process probe. */
  timeoutMs: number
  /** Copy the workspace per probe side; disable only when the task cannot touch files. */
  isolate: boolean
  /** Sessions contributing to one diagnosis, newest first. */
  maxSessions: number
  /** Prefix for the package name of an adopted candidate bundle. */
  packagePrefix: string
  /** Profile patch that `fracture_adopt` appends to when `apply` is set. */
  profilePatch: string
  /** How much the loop may do without being asked. `off` disables observation entirely. */
  autonomy: Autonomy
  /** Observed turns between memory digest rewrites. */
  digestEvery: number
  /** Clean repetitions before a procedure is written out as a skill. */
  distillMinRepeats: number
  /** Apply a prompt-only candidate to the live agent when its probe says improved. */
  autoApply: boolean
  /** Turns watched after an automatic apply before it is kept or reverted. */
  watchTurns: number
  /** Applied changes that may be watched at the same time. */
  maxWatches: number
  /** Loops the idle trigger may start per rolling hour. */
  maxLoopsPerHour: number
  /** Probes the loop may run per rolling hour. */
  maxProbesPerHour: number
  /** Turns that must pass after a loop before the next one may start. */
  minTurnsBetweenLoops: number
  /**
   * How to judge a probe that has no deterministic check.
   *
   * `off` leaves it as `needs-review` for a human. `rubric` asks a second model
   * to score both trajectories; that is one opinion, and the report says so.
   */
  judge: 'off' | 'rubric'
  /** Let the idle trigger run the whole loop without being asked. */
  autoLoop: boolean
}

export const Config: z<Config> = z.object({
  baseDir: z.string().default('.dsh/fracture'),
  provider: z.string().default('spawn'),
  dshCommand: z.string().default('dsh'),
  profile: z.string().default('headless'),
  timeoutMs: z.number().default(900_000),
  isolate: z.boolean().default(true),
  maxSessions: z.number().default(12),
  packagePrefix: z.string().default('dsh-fracture-candidate'),
  profilePatch: z.string().default(''),
  autonomy: z.union(['off', 'memory', 'skills', 'full']).default('full'),
  digestEvery: z.number().default(20),
  distillMinRepeats: z.number().default(3),
  autoApply: z.boolean().default(true),
  watchTurns: z.number().default(12),
  maxWatches: z.number().default(3),
  maxLoopsPerHour: z.number().default(2),
  maxProbesPerHour: z.number().default(1),
  minTurnsBetweenLoops: z.number().default(8),
  judge: z.union(['off', 'rubric']).default('off'),
  autoLoop: z.boolean().default(true),
})

const OUTPUT = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function storeOf(config: Config): Store {
  return new Store(resolve(config.baseDir))
}

/** Events retained per session, enough for a diagnosis without unbounded growth. */
const BUFFER_LIMIT = 2_000

/** The agent behind a tool call, when the caller has one. */
function analyzedAgent(exec: ToolRunContext): Agent | undefined {
  return exec.agent
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('this tool needs a live agent; call it from a session, not from a nested dispatcher')
  return exec.agent
}

function renderDiagnosis(diagnosis: Diagnosis, savedPath: string, shownSessions: number): string {
  const tools = diagnosis.toolStats
    .slice(0, 12)
    .map(stat => `| \`${stat.name}\` | ${String(stat.calls)} | ${String(stat.failures)} |`)
  const findings = diagnosis.findings.length === 0
    ? ['_No finding crossed its threshold. The harness looks healthy on this sample._']
    : diagnosis.findings.map(item => `- **${item.id}** (${item.severity}, likely lever \`${item.lever}\`): ${item.evidence}`)

  return [
    '# Diagnosis',
    '',
    `- sessions read: ${String(shownSessions)}`,
    `- events: ${String(diagnosis.events)}`,
    `- feedback: ${String(diagnosis.feedback.positive)} positive, ${String(diagnosis.feedback.negative)} negative`,
    `- tokens: ${diagnosis.tokens === null ? 'not recorded in these sessions' : `${String(diagnosis.tokens.input)} in / ${String(diagnosis.tokens.output)} out`}`,
    `- snapshot: ${savedPath}`,
    '',
    '## Tools',
    '',
    '| tool | calls | failures |',
    '| --- | --- | --- |',
    ...tools,
    '',
    '## Findings',
    '',
    ...findings,
    '',
    'Next: `fracture_propose` with one finding id and the task the harness should handle better.',
  ].join('\n')
}

function renderProbe(result: Awaited<ReturnType<typeof runProbe>>, store: Store): string {
  const baselineCalls = result.baseline.trajectory.steps.length
  const changedCalls = result.changed.trajectory.steps.length
  return [
    `# Probe ${result.runId}`,
    '',
    `- candidate: \`${result.candidateId}\``,
    `- mode: \`${result.mode}\``,
    `- verdict: **${result.verdict}**`,
    `- reason: ${result.reason}`,
    `- tool steps: ${String(baselineCalls)} baseline vs ${String(changedCalls)} changed`,
    `- tool errors: ${String(result.baseline.trajectory.toolErrors)} baseline vs ${String(result.changed.trajectory.toolErrors)} changed`,
    result.baseline.error === undefined ? '' : `- baseline error: ${result.baseline.error}`,
    result.changed.error === undefined ? '' : `- changed error: ${result.changed.error}`,
    '',
    `Report: \`${join(store.runDir(result.runId), 'report.md')}\``,
    '',
    result.verdict === 'improved'
      ? 'Next: read report.md, confirm the win on a second task, then `fracture_adopt`.'
      : 'Next: read report.md and decide whether to revise the candidate or drop it.',
  ].filter(line => line !== '').join('\n')
}

/**
 * Register the loop's tools.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const store = storeOf(config)
  const pilot = new Autopilot(store, { digestEvery: config.digestEvery, distillMinRepeats: config.distillMinRepeats })
  const buffers = new Map<string, RawEvent[]>()
  const live = new Map<unknown, LiveHandle>()
  const overrides = new Map<string, Applied>()
  const policy: PolicyConfig = {
    autonomy: config.autonomy,
    maxLoopsPerHour: config.maxLoopsPerHour,
    maxProbesPerHour: config.maxProbesPerHour,
    minTurnsBetweenLoops: config.minTurnsBetweenLoops,
    watchTurns: config.watchTurns,
    maxWatches: config.maxWatches,
  }
  const lifetime = new AbortController()

  const skillsFor = () => pilot.skills.map(skill => ({
    name: skill.name,
    description: skill.description,
    content: skill.content,
  }))

  /** Attach the memory section and the distilled skills to one agent. */
  const attach = (agent: unknown): void => {
    if (live.has(agent)) return
    try {
      const handle = installLive(agent as LiveAgent, () => pilot.index)
      handle.reconcile(skillsFor())
      live.set(agent, handle)
    } catch (error) {
      void journal(store, `could not extend an agent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Give a candidate the task's stored check when it declares none.
   * @param candidate - the candidate as authored.
   * @param task - the task the probe will run.
   * @returns the candidate, possibly with a `verify` borrowed from the criteria.
   */
  const withTaskVerify = async (candidate: Candidate, task: string): Promise<Candidate> => {
    if ((candidate.verify ?? '').trim() !== '') return candidate
    const criteria = await store.criteriaForTask(task)
    if (criteria?.verify === undefined) return candidate
    await journal(store, `using the stored check for "${task.trim()}" on ${candidate.id}: ${criteria.verify}`)
    return { ...candidate, verify: criteria.verify }
  }

  /**
   * Put a prompt-only candidate live on one agent and start watching it.
   * @param agent - the agent whose prompt changes.
   * @param candidate - a candidate that passed its probe.
   * @returns a line describing what happened, for the tool result.
   */
  const autoApplyCandidate = async (agent: unknown, candidate: Candidate, probeTokens?: number): Promise<string> => {
    if (!config.autoApply) return 'auto-apply is off; the candidate stays a bundle.'
    if (!tierAllowed(config.autonomy, 2)) return `autonomy \`${config.autonomy}\` does not reach composition changes.`
    const allowed = applyability(candidate)
    if (!allowed.ok) return `not applied live: ${allowed.reason}.`
    if (pilot.watches.length >= config.maxWatches) {
      const open = pilot.watches.map(watch => `\`${watch.candidateId}\``).join(', ')
      return `not applied: already watching ${String(pilot.watches.length)} changes (${open}).`
    }
    if (pilot.watches.some(watch => watch.candidateId === candidate.id)) return `not applied: \`${candidate.id}\` is already being watched.`
    const override = overrideOf(candidate)
    if (override === undefined) return 'not applied live: the candidate has no prompt text.'

    try {
      overrides.set(candidate.id, applyOverride(agent as LiveAgent, override))
      const recent = await readObservations(store, config.watchTurns)
      // The probe's first-turn count is the only real sample of what this change
      // costs before any work happens, so it backs the watch when live turns
      // carry no usage of their own.
      await pilot.openWatch(candidate.id, metricsFrom(recent, probeTokens ?? 0), config.watchTurns)
      await journal(store, `applied ${candidate.id} to a live agent; watching ${String(config.watchTurns)} turns`)
      notify(
        agent as Agent,
        `Applied \`${candidate.id}\` to this session's prompt (section \`${override.sectionName}\`).\n\n${candidate.prompt ?? ''}\n\nWatching ${String(config.watchTurns)} turns; reverting on its own if the numbers get worse.`,
        `applied ${candidate.id}, watching ${String(config.watchTurns)} turns`,
      )
      return `applied live as section \`${override.sectionName}\`; watching ${String(config.watchTurns)} turns.`
    } catch (error) {
      await journal(store, `apply of ${candidate.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return `applying live failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Run the whole loop without being asked: diagnose, propose, probe, apply.
   * @param agent - the agent whose harness may change.
   * @param task - optional task override; otherwise the most repeated task is used.
   * @returns a one-line account of what happened.
   */
  const runAutoLoop = async (agent: Agent, task?: string): Promise<string> => {
    const decision = shouldAutoLoop({
      autonomy: config.autonomy,
      policy,
      state: pilot.state,
      now: Date.now(),
      watching: pilot.watches.length >= config.maxWatches,
    })
    if (!decision.ok) return `skipped: ${decision.reason}`

    await pilot.noteLoop(Date.now())
    try {
      const slices = await loadSessions(ctx, config.maxSessions, lifetime.signal)
      if (slices.length === 0) {
        await pilot.noteSuccess()
        return 'skipped: no stored session could be read'
      }
      const diagnosis = diagnose(slices.map(slice => slice.events))
      const strongest = diagnosis.findings.find(item => item.severity !== 'low')
      if (strongest === undefined) {
        await pilot.noteSuccess()
        await journal(store, 'auto loop: nothing crossed a threshold')
        return 'skipped: nothing crossed a threshold'
      }
      const chosen = task ?? pickTask(await readObservations(store, 60))
      if (chosen === undefined) {
        await pilot.noteSuccess()
        return 'skipped: no task repeated enough times to be worth a probe'
      }

      const proposal = await propose({
        ctx,
        store,
        settings: { provider: config.provider, timeoutMs: config.timeoutMs },
        agent,
        diagnosis,
        task: chosen,
        cwd: process.cwd(),
        signal: lifetime.signal,
        finding: strongest.id,
      })
      const candidate = proposal.accepted[0]
      if (candidate === undefined) {
        await pilot.noteSuccess()
        await journal(store, `auto loop: proposer wrote no acceptable candidate for ${strongest.id}`)
        return `skipped: no acceptable candidate for ${strongest.id}`
      }

      await pilot.noteProbe(Date.now())
      const checked = await withTaskVerify(candidate, chosen)
      const result = await runProbe({
        ctx,
        store,
        settings: {
          provider: config.provider,
          dshCommand: config.dshCommand,
          profile: config.profile,
          timeoutMs: config.timeoutMs,
          isolate: config.isolate,
          judge: config.judge,
        },
        candidate: checked,
        task: chosen,
        cwd: process.cwd(),
        agent,
        signal: lifetime.signal,
      })
      await pilot.noteSuccess()
      await journal(store, `auto loop: ${candidate.id} probed ${result.verdict} on "${chosen}"`)
      if (result.verdict !== 'improved') {
        await journal(store, `auto loop: ${candidate.id} probed ${result.verdict}, not applied`)
        return `probed ${candidate.id}: ${result.verdict}, not applied`
      }
      const applied = await autoApplyCandidate(agent, candidate, result.changed.promptTokens)
      return `probed ${candidate.id}: improved. ${applied}`
    } catch (error) {
      await pilot.noteFailure()
      const message = error instanceof Error ? error.message : String(error)
      await journal(store, `auto loop failed: ${message}`)
      return `failed: ${message}`
    }
  }

  if (config.autonomy !== 'off') {
    // The agents service is optional: a profile without it still gets tools and
    // observation, just no prompt section to attach to.
    const agents = ctx.get('agents') as { list(): unknown[]; get?(id: string): unknown } | undefined
    const agentFor = (sessionId: string): Agent | undefined => agents?.get?.(sessionId) as Agent | undefined
    const attachAll = (): void => {
      for (const agent of agents?.list() ?? []) attach(agent)
    }

    void pilot.load().then(attachAll).catch((error: unknown) => {
      void journal(store, `autopilot could not load: ${error instanceof Error ? error.message : String(error)}`)
    })

    attachAll()
    ctx.on('agent/created', ({ agent }) => {
      attach(agent)
      return undefined
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const handle = live.get(agent)
      if (handle === undefined) return
      live.delete(agent)
      void handle.dispose()
    })

    ctx.on('session/event', (session, event) => {
      const id = String(session.id)
      const buffer = buffers.get(id) ?? []
      buffer.push(event as RawEvent)
      if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
      buffers.set(id, buffer)
      if (event.type !== 'turn/end') return
      void pilot.observe(id, buffer).then(async result => {
        if (result.skillsWritten.length > 0) {
          for (const handle of live.values()) handle.reconcile(skillsFor())
          const agent = agentFor(id)
          if (agent !== undefined) {
            notify(
              agent,
              `Distilled ${String(result.skillsWritten.length)} skill(s): ${result.skillsWritten.join(', ')}.\n\nThey are registered on this session and listed in the prompt index.`,
              `distilled ${result.skillsWritten.join(', ')}`,
            )
          }
        }
        for (const outcome of result.watches ?? []) {
          if (!outcome.revert) continue
          const applied = overrides.get(outcome.candidateId)
          if (applied === undefined) continue
          overrides.delete(outcome.candidateId)
          await revertOverride(applied)
          await journal(store, `reverted ${outcome.candidateId}: ${outcome.reason}`)
          const agent = agentFor(id)
          if (agent !== undefined) {
            notify(agent, `Reverted \`${outcome.candidateId}\`: ${outcome.reason}.`, `reverted ${outcome.candidateId}`)
          }
        }
        return result
      }).catch((error: unknown) => {
        void journal(store, `observation failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    ctx.effect(() => {
      const timer = setInterval(() => {
        attachAll()
        void pilot.refreshDigest().catch(() => undefined)
        if (!config.autoLoop) return
        const agent = agents?.list()[0]
        if (agent === undefined) return
        void runAutoLoop(agent as Agent).then(line => {
          if (!line.startsWith('skipped')) void journal(store, `auto loop: ${line}`)
        })
      }, 15 * 60_000)
      timer.unref()
      return () => {
        clearInterval(timer)
        lifetime.abort(new Error('fracture is unloading'))
      }
    }, 'fracture: idle loop')
  }

  ctx.tools.register(defineTool({
    name: 'fracture_diagnose',
    description: [
      'Read the newest stored sessions and rank what the current harness is doing badly.',
      'Reports tool failure rates, repeated reads, approval denials, compaction pressure, and message feedback,',
      'saved as a snapshot under the fracture base directory.',
      'Use this first; every later step cites a finding id from here.',
    ].join(' '),
    parameters: {
      sessions: { type: 'integer', description: 'How many recent sessions to read. Defaults to the plugin setting.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const limit = args.sessions ?? config.maxSessions
      await store.ensure()
      const slices = await loadSessions(ctx, limit, exec.signal)
      if (slices.length === 0) return 'No stored sessions could be read, so there is nothing to diagnose yet.'
      const diagnosis = diagnose(slices.map(slice => slice.events))
      const stamp = timestamp()
      const savedPath = await store.saveDiagnosis({ ...diagnosis, sessionIds: slices.map(slice => slice.id) }, stamp)
      return renderDiagnosis(diagnosis, savedPath, slices.length)
    },
  }))


  ctx.tools.register(defineTool({
    name: 'fracture_plan',
    description: [
      'Turn a request into acceptance criteria before any work starts.',
      'Writes criteria/<id>.json with two to five checks, preferring a command that exits non-zero while the task is not done.',
      'When the request cannot be made checkable it refuses and says why, rather than inventing a check.',
      'A probe for the same task uses the first command check when the candidate declares no verify of its own.',
    ].join(' '),
    parameters: {
      task: { type: 'string', required: true, description: 'The request, verbatim.' },
      force: { type: 'boolean', description: 'Rewrite even when criteria for this task already exist.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      await store.ensure()
      const existing = await store.criteriaForTask(args.task)
      if (existing !== undefined && args.force !== true) {
        return `${renderCriteria(existing)}\n\n_Reused. Pass \`force\` to rewrite._`
      }

      // Criteria written against what has been failing are the ones worth having;
      // a generic "run the tests" is what a model writes without evidence.
      const observations = await readObservations(store, 60)
      const failures = new Map<string, number>()
      for (const observation of observations) {
        for (const failure of observation.failures) {
          const key = `${failure.tool} fails with ${failure.code}`
          failures.set(key, (failures.get(key) ?? 0) + 1)
        }
      }
      const context = [...failures.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([key, count]) => `${key} (${String(count)}x)`)

      const run = await runChild(
        ctx,
        config.provider,
        requireAgent(exec),
        buildCriteriaPrompt(args.task, context),
        process.cwd(),
        exec.signal,
      )
      const raw = run.side.trajectory.finalText.trim()
      const criteria = parseCriteria(raw, args.task, new Date().toISOString())
      if (criteria === undefined) {
        return [
          'The planner did not produce usable criteria.',
          '',
          raw === '' ? '_It returned nothing._' : `\`\`\`text\n${raw.slice(0, 2_000)}\n\`\`\``,
        ].join('\n')
      }
      const path = await store.writeCriteria(criteria)
      await journal(store, `criteria for "${args.task.trim()}" written to ${path} (${String(criteria.checks.length)} checks)`)
      return renderCriteria(criteria)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fracture_propose',
    description: [
      'Send a proposer subagent to write one candidate harness edit as data.',
      'A candidate is a short list of Cordis rows plus an optional skill or plugin file, stored under',
      'candidates/<id>/ with a rationale tied to a diagnosis finding.',
      'The proposer cannot install anything; it only writes files, and every candidate is validated',
      'against the protected surface before it is accepted.',
    ].join(' '),
    parameters: {
      task: { type: 'string', required: true, description: 'The task the harness should get better at. The probe runs this task.' },
      finding: { type: 'string', description: 'Finding id from fracture_diagnose to target. Omit to let the proposer choose the strongest one.' },
      sessions: { type: 'integer', description: 'How many recent sessions the inline diagnosis reads.' },
      cwd: { type: 'string', description: 'Directory the proposer works in. Defaults to the process directory.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const agent = requireAgent(exec)
      await store.ensure()
      const slices = await loadSessions(ctx, args.sessions ?? config.maxSessions, exec.signal)
      const diagnosis = diagnose(slices.map(slice => slice.events))
      const outcome = await propose({
        ctx,
        store,
        settings: { provider: config.provider, timeoutMs: config.timeoutMs },
        agent,
        diagnosis,
        task: args.task,
        cwd: resolve(args.cwd ?? process.cwd()),
        signal: exec.signal,
        ...(args.finding === undefined ? {} : { finding: args.finding }),
      })
      const accepted = outcome.accepted.map(candidate => [
        `- \`${candidate.id}\` (${candidate.lever}, ${String(candidate.rows.length)} row(s)): ${candidate.title}`,
        `  - answers: ${candidate.finding}`,
        `  - rows: ${candidate.rows.map(row => `\`${row.name}\``).join(', ')}`,
        candidate.verify === undefined ? '  - verify: none declared' : `  - verify: \`${candidate.verify}\``,
      ].join('\n'))
      const rejected = outcome.rejected.map(entry => `- \`${entry.id}\`: ${entry.problems.join('; ')}`)
      return [
        '# Proposal',
        '',
        accepted.length === 0 ? '_No candidate was accepted._' : '## Accepted',
        ...accepted,
        ...(rejected.length === 0 ? [] : ['', '## Rejected', ...rejected]),
        '',
        `Stored under \`${store.candidatesDir}\`.`,
        accepted.length === 0 ? '' : 'Next: `fracture_probe` with a candidate id and the task to run.',
        outcome.childMessage.trim() === '' ? '' : `## Proposer note\n\n${outcome.childMessage.trim().slice(0, 2_000)}`,
      ].filter(line => line !== '').join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fracture_probe',
    description: [
      'Run one task twice, on the current harness and with the candidate rows inserted, and compare.',
      'Rows-only candidates run as a child agent in this process; a candidate that ships a plugin runs',
      'in a separate dsh process so unverified code never loads here.',
      'Writes result.json and a readable report.md under runs/<run id>/.',
      'Without a deterministic verify command the verdict is needs-review and both trajectories are shown.',
    ].join(' '),
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Candidate directory name under the base directory.' },
      task: { type: 'string', required: true, description: 'Task to run on both sides. Use the same wording as the reference run.' },
      verify: { type: 'string', description: 'Shell command that exits non-zero when the harness fails. Overrides the candidate value.' },
      cwd: { type: 'string', description: 'Workspace to copy for the probe. Defaults to the process directory.' },
      isolate: { type: 'boolean', description: 'Copy the workspace per side. Disable only when the task cannot write files.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const stored = await store.readCandidate(args.candidateId)
      const candidate: Candidate = args.verify === undefined ? stored : { ...stored, verify: args.verify }
      const effective = await withTaskVerify(candidate, args.task)
      const problems = candidateProblems(effective)
      if (problems.length > 0) throw new Error(`candidate ${candidate.id} is not probeable:\n- ${problems.join('\n- ')}`)
      const result = await runProbe({
        ctx,
        store,
        settings: {
          provider: config.provider,
          dshCommand: config.dshCommand,
          profile: config.profile,
          timeoutMs: config.timeoutMs,
          isolate: args.isolate ?? config.isolate,
          judge: config.judge,
        },
        candidate: effective,
        task: args.task,
        cwd: resolve(args.cwd ?? process.cwd()),
        agent,
        signal: exec.signal,
      })
      const applied = result.verdict === 'improved'
        ? await autoApplyCandidate(analyzedAgent(exec), candidate, result.changed.promptTokens)
        : 'not applied: the probe did not come back improved.'
      return `${renderProbe(result, store)}\n\n## Live apply\n\n${applied}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fracture_adopt',
    description: [
      'Turn a probed candidate into an installable bundle under candidates/<id>/bundle/.',
      'Refuses unless the newest probe for that candidate came back improved, or force is set.',
      'Never installs: the bundle is installed by a human-run command or the plugin manager, which is',
      'the approval gate for host code. With apply it appends the rows to the configured profile patch.',
    ].join(' '),
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Candidate directory name under the base directory.' },
      apply: { type: 'boolean', description: 'Also append the rows to the configured profile patch. Off by default.' },
      force: { type: 'boolean', description: 'Adopt despite a missing probe or a verdict other than improved.' },
    },
    output: OUTPUT,
    async execute(args) {
      const candidate = await store.readCandidate(args.candidateId)
      const outcome = await adopt(store, candidate, {
        packagePrefix: config.packagePrefix,
        ...(config.profilePatch === '' ? {} : { profilePatch: resolve(config.profilePatch) }),
        apply: args.apply === true,
        force: args.force === true,
      })
      await store.appendLesson([
        `## ${candidate.id}: ${candidate.title}`,
        '',
        `- cue: ${candidate.finding}`,
        `- change: ${candidate.rows.map(row => `\`${row.name}\``).join(', ')}`,
        `- lever: ${candidate.lever}`,
        `- probe: ${outcome.verdict}`,
        `- bundle: ${outcome.bundleDir}`,
        `- applied: ${outcome.applied ? 'yes' : 'no (bundle only)'}`,
        `- when: ${new Date().toISOString()}`,
        '',
        `Rationale: ${candidate.rationale}`,
      ].join('\n'))
      return [
        `# Adopted ${candidate.id}`,
        '',
        `- verdict: ${outcome.verdict}`,
        `- package: \`${outcome.packageName}\``,
        `- bundle: \`${outcome.bundleDir}\``,
        `- profile patch written: ${outcome.applied ? 'yes' : 'no'}`,
        '',
        outcome.instructions,
        '',
        `Lesson appended to \`${store.lessonsPath}\`.`,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fracture_loop',
    description: [
      'Run the whole loop once without further prompting: diagnose, propose, probe, and apply a prompt-level',
      'candidate if the contrast comes back improved.',
      'Refuses when a watch window is open, the hourly budget is spent, or nothing crossed a threshold.',
      'The idle trigger runs the same path every 15 minutes.',
    ].join(' '),
    parameters: {
      task: { type: 'string', description: 'Task to improve the harness for. Defaults to the most repeated task in memory.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const agent = requireAgent(exec)
      return runAutoLoop(agent, args.task)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: [
      'Search what this harness has learned on its own: the memory digest, past turns, and distilled skills.',
      'Use it before re-deriving a procedure or re-discovering a convention from a previous session.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Case-insensitive substring. An empty query returns the newest turns.' },
      limit: { type: 'integer', description: 'Maximum hits. Defaults to 12.' },
    },
    output: OUTPUT,
    async execute(args) {
      const hits = await searchMemory(store, args.query, args.limit ?? 12)
      if (hits.length === 0) return 'Nothing in memory matched that query.'
      return [
        `# Memory search: ${args.query}`,
        '',
        ...hits.map(hit => `- (${hit.kind}) ${hit.text}`),
        '',
        `Index and digest live under \`${store.memoryDir}\`.`,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fracture_status',
    description: 'Show what the loop has learned, what it has proposed, and how each candidate scored.',
    parameters: {},
    output: OUTPUT,
    async execute() {
      // Re-read the store so the report reflects the disk, not the state this
      // instance saw when it loaded. A live reload starts the plugin with an
      // empty index even when the base directory already has a digest.
      await pilot.load()
      const ids = await store.listCandidateIds()
      const rows: string[] = []
      for (const id of ids) {
        try {
          const candidate = await store.readCandidate(id)
          const probe = await latestProbe(store, id)
          rows.push(`- \`${id}\` (${candidate.lever}): ${candidate.title} → ${probe === undefined ? 'unprobed' : `${probe.verdict} (${probe.runId})`}`)
        } catch {
          rows.push(`- \`${id}\`: candidate.json is unreadable`)
        }
      }
      const skills = pilot.skills
      const latest = skills.slice(0, 12).map(skill => `  - \`${skill.name}\`: ${skill.description}`)
      return [
        '# Self-harness status',
        '',
        `- base: \`${store.baseDir}\``,
        `- autonomy: \`${config.autonomy}\``,
        `- turns observed: ${String(pilot.index.observations)}`,
        `- digest sections: ${pilot.index.digestHeadings.length === 0 ? 'none yet' : pilot.index.digestHeadings.join(', ')}`,
        `- distilled skills: ${String(skills.length)}`,
        `- watching: ${pilot.watches.length === 0 ? 'nothing' : pilot.watches.map(watch => `\`${watch.candidateId}\` until turn ${String(watch.dueAtTurn)}`).join(', ')}`,
        ...latest,
        '',
        `- criteria: ${String((await store.listCriteriaIds()).length)}`,
        `- candidates: ${String(ids.length)}`,
        '',
        ...(ids.length === 0 ? ['_No candidates yet. Run `fracture_diagnose`, then `fracture_propose`._'] : rows),
        '',
        `- lessons: \`${store.lessonsPath}\``,
      ].join('\n')
    },
  }))
}
