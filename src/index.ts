/**
 * dsh-self-harness: let a DSH agent improve its own harness.
 *
 * The loop is diagnose → propose → probe → adopt. Each step is a tool the model
 * calls itself, and every artifact the loop produces is a file the user can
 * read, diff, and delete. Nothing here edits a running profile behind the
 * user's back: adoption produces a bundle, and installing that bundle stays a
 * human-approved action.
 *
 * @module dsh-self-harness
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { adopt, latestProbe } from './adopt.js'
import { diagnose } from './diagnose.js'
import { candidateProblems } from './guard.js'
import { propose } from './propose.js'
import { runProbe } from './probe.js'
import { loadSessions } from './sessions.js'
import { Store } from './store.js'
import type { Candidate, Diagnosis } from './types.js'

export const name = 'self-harness'

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
  /** Profile patch that `self_adopt` appends to when `apply` is set. */
  profilePatch: string
}

export const Config: z<Config> = z.object({
  baseDir: z.string().default('.dsh/self-harness'),
  provider: z.string().default('spawn'),
  dshCommand: z.string().default('dsh'),
  profile: z.string().default('headless'),
  timeoutMs: z.number().default(900_000),
  isolate: z.boolean().default(true),
  maxSessions: z.number().default(12),
  packagePrefix: z.string().default('dsh-self-harness-candidate'),
  profilePatch: z.string().default(''),
})

const OUTPUT = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function storeOf(config: Config): Store {
  return new Store(resolve(config.baseDir))
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
    'Next: `self_propose` with one finding id and the task the harness should handle better.',
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
      ? 'Next: read report.md, confirm the win on a second task, then `self_adopt`.'
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

  ctx.tools.register(defineTool({
    name: 'self_diagnose',
    description: [
      'Read the newest stored sessions and rank what the current harness is doing badly.',
      'Reports tool failure rates, repeated reads, approval denials, compaction pressure, and message feedback,',
      'saved as a snapshot under the self-harness base directory.',
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
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const savedPath = await store.saveDiagnosis({ ...diagnosis, sessionIds: slices.map(slice => slice.id) }, stamp)
      return renderDiagnosis(diagnosis, savedPath, slices.length)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_propose',
    description: [
      'Send a proposer subagent to write one candidate harness edit as data.',
      'A candidate is a short list of Cordis rows plus an optional skill or plugin file, stored under',
      'candidates/<id>/ with a rationale tied to a diagnosis finding.',
      'The proposer cannot install anything; it only writes files, and every candidate is validated',
      'against the protected surface before it is accepted.',
    ].join(' '),
    parameters: {
      task: { type: 'string', required: true, description: 'The task the harness should get better at. The probe runs this task.' },
      finding: { type: 'string', description: 'Finding id from self_diagnose to target. Omit to let the proposer choose the strongest one.' },
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
        accepted.length === 0 ? '' : 'Next: `self_probe` with a candidate id and the task to run.',
        outcome.childMessage.trim() === '' ? '' : `## Proposer note\n\n${outcome.childMessage.trim().slice(0, 2_000)}`,
      ].filter(line => line !== '').join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_probe',
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
      const candidate = await store.readCandidate(args.candidateId)
      const effective: Candidate = args.verify === undefined ? candidate : { ...candidate, verify: args.verify }
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
        },
        candidate: effective,
        task: args.task,
        cwd: resolve(args.cwd ?? process.cwd()),
        agent,
        signal: exec.signal,
      })
      return renderProbe(result, store)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_adopt',
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
    name: 'self_status',
    description: 'List candidates in the self-harness base directory with the verdict of their newest probe.',
    parameters: {},
    output: OUTPUT,
    async execute() {
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
      return [
        '# Self-harness status',
        '',
        `- base: \`${store.baseDir}\``,
        `- candidates: ${String(ids.length)}`,
        '',
        ...(ids.length === 0 ? ['_No candidates yet. Run `self_diagnose`, then `self_propose`._'] : rows),
        '',
        `- lessons: \`${store.lessonsPath}\``,
      ].join('\n')
    },
  }))
}
