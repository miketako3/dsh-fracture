/**
 * Probing: run one task twice, once on the current harness and once with the
 * candidate rows inserted, then compare what actually happened.
 *
 * Two execution paths exist on purpose. A rows-only candidate runs as a child
 * agent in this process, which costs seconds. A candidate that ships code runs
 * as a separate `dsh` process, because unverified code must not share the
 * host process with the session that is judging it.
 */

import { exec as execCallback, spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { Candidate, ProbeMode, ProbeResult, ProbeSide, Verdict } from './types.js'
import { EMPTY_TRAJECTORY, messageOf, runChild } from './child.js'
import { firstPromptTokensFromHeadless, renderTrajectory, trajectoryFromHeadless } from './trajectory.js'
import { isolateWorkspace } from './workspace.js'
import { judge, renderJudge } from './judge.js'
import type { JudgeOutcome } from './judge.js'
import { timestamp, writeJson, type Store } from './store.js'

const execAsync = promisify(execCallback)

/** Runtime knobs the probe needs; a subset of the plugin config. */
export interface ProbeSettings {
  readonly provider: string
  readonly dshCommand: string
  readonly profile: string
  readonly timeoutMs: number
  readonly isolate: boolean
  /** Whether to score the two sides with a second model when no check exists. */
  readonly judge: 'off' | 'rubric'
}

/** Everything one probe needs from the host. */
export interface ProbeRequest {
  readonly ctx: Context
  readonly store: Store
  readonly settings: ProbeSettings
  readonly candidate: Candidate
  readonly task: string
  readonly cwd: string
  readonly agent: Agent
  readonly signal: AbortSignal
}

/** Whether a candidate ships code, which decides the execution path. */
export async function probeMode(store: Store, candidate: Candidate): Promise<ProbeMode> {
  try {
    const entries = await readdir(join(store.candidateDir(candidate.id), 'plugin'))
    return entries.length > 0 ? 'out-of-process' : 'in-process'
  } catch {
    return 'in-process'
  }
}

const QUIET_SUFFIX = ['', '---', 'Work only inside the current directory.', 'Do not ask questions. Make a decision and finish.'].join('\n')

/** The exact child prompt for one probe side; both sides get the same text. */
export function probePrompt(task: string): string {
  return `${task.trim()}\n${QUIET_SUFFIX}`
}

/** Run one side as a separate `dsh` process against a generated patch. */
async function runOutOfProcess(
  settings: ProbeSettings,
  task: string,
  cwd: string,
  signal: AbortSignal,
  patchPath?: string,
): Promise<ProbeSide> {
  const args = ['--profile', settings.profile, ...(patchPath === undefined ? [] : ['--patch', patchPath]), '--json', probePrompt(task)]
  const combined = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)])

  return await new Promise<ProbeSide>((resolve) => {
    let settled = false
    const finish = (side: ProbeSide): void => {
      if (settled) return
      settled = true
      resolve(side)
    }

    let child
    try {
      child = spawn(settings.dshCommand, args, { cwd, signal: combined, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ passed: null, trajectory: EMPTY_TRAJECTORY, error: `could not spawn ${settings.dshCommand}: ${messageOf(error)}` })
      return
    }

    const out: string[] = []
    const err: string[] = []
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { out.push(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { err.push(chunk) })

    child.on('error', (error: Error) => {
      finish({ passed: null, trajectory: EMPTY_TRAJECTORY, error: `could not run ${settings.dshCommand}: ${error.message}` })
    })

    child.on('close', (code) => {
      const events: unknown[] = []
      for (const line of out.join('').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          // Non-JSON stdout stays out of the trajectory.
        }
      }
      const stderr = err.join('').trim()
      const tokens = firstPromptTokensFromHeadless(events)
      finish({
        passed: null,
        trajectory: trajectoryFromHeadless(events),
        ...(tokens === undefined ? {} : { promptTokens: tokens }),
        ...(code === 0 ? {} : { error: `exited with code ${String(code)}${stderr === '' ? '' : `: ${stderr.slice(-400)}`}` }),
      })
    })
  })
}

/** Run the candidate's deterministic check in one workspace. */
async function runVerify(command: string, cwd: string, timeoutMs: number): Promise<{ passed: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { passed: true, detail: `${stdout}${stderr}`.trim().slice(-600) }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const tail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().slice(-600)
    return { passed: false, detail: tail === '' ? (failure.message ?? 'check failed') : tail }
  }
}

/** Decide the verdict from two sides and the optional check results. */
export function verdictOf(
  hasVerify: boolean,
  baselinePassed: boolean | null,
  changedPassed: boolean | null,
): { verdict: Verdict; reason: string } {
  if (!hasVerify) {
    return { verdict: 'needs-review', reason: 'No deterministic check was declared, so the two trajectories need a human or rubric read before adopting.' }
  }
  if (baselinePassed === null || changedPassed === null) {
    return { verdict: 'needs-review', reason: 'The check did not run on both sides.' }
  }
  if (!baselinePassed && changedPassed) {
    return { verdict: 'improved', reason: 'The check failed on the current harness and passed with the candidate rows.' }
  }
  if (baselinePassed && !changedPassed) {
    return { verdict: 'regressed', reason: 'The check passed on the current harness and failed with the candidate rows.' }
  }
  if (baselinePassed && changedPassed) {
    return { verdict: 'no-change', reason: 'Both sides passed; this task cannot distinguish them.' }
  }
  return { verdict: 'no-change', reason: 'Both sides failed; the task or the check needs attention before the harness is judged.' }
}

/** Register the candidate as a preset, run the child under it, and always unregister. */
async function runWithCandidatePreset(
  ctx: Context,
  settings: ProbeSettings,
  candidate: Candidate,
  task: string,
  cwd: string,
  parent: Agent,
  signal: AbortSignal,
): Promise<ProbeSide> {
  const presetId = `fracture-${candidate.id}`
  let unregister: (() => Promise<void>) | undefined
  try {
    // Rows come from JSON authored by the proposer; the registry's own entry
    // validation is the authority on whether they mount.
    unregister = await ctx.agentPresets.register({
      id: presetId,
      name: `fracture candidate ${candidate.id}`,
      description: candidate.title,
      plugins: candidate.rows as unknown as PresetDefinition['plugins'],
    })
    // A mount failure resolves instead of rejecting, so the preset must be
    // read back: a broken candidate would otherwise run the baseline rows and
    // report a result for a change that never loaded.
    const mounted = await ctx.agentPresets.resolve(presetId)
    if (mounted.broken !== undefined) throw new Error(`candidate preset did not mount: ${mounted.broken}`)
    return (await runChild(ctx, settings.provider, parent, probePrompt(task), cwd, signal, presetId)).side
  } catch (error) {
    return { passed: null, trajectory: EMPTY_TRAJECTORY, error: messageOf(error) }
  } finally {
    // A candidate preset must never outlive its probe: a leaked revision keeps
    // composing agents that were never adopted.
    if (unregister !== undefined) await unregister().catch(() => undefined)
  }
}

/** Execute one probe and persist its evidence. */
export async function runProbe(request: ProbeRequest): Promise<ProbeResult> {
  const { ctx, store, settings, candidate, task, cwd, signal, agent } = request
  const mode = await probeMode(store, candidate)
  const runId = `${timestamp()}-${candidate.id}`
  const runDir = store.runDir(runId)
  const startedAt = new Date().toISOString()

  let baselineCwd = cwd
  let changedCwd = cwd
  if (settings.isolate) {
    baselineCwd = (await isolateWorkspace(cwd, join(runDir, 'baseline'), [store.baseDir])).dir
    changedCwd = (await isolateWorkspace(cwd, join(runDir, 'changed'), [store.baseDir])).dir
  }

  signal.throwIfAborted()

  let baseline: ProbeSide
  let changed: ProbeSide

  if (mode === 'in-process') {
    baseline = (await runChild(ctx, settings.provider, agent, probePrompt(task), baselineCwd, signal)).side
    signal.throwIfAborted()
    changed = await runWithCandidatePreset(ctx, settings, candidate, task, changedCwd, agent, signal)
  } else {
    const patchPath = join(store.candidateDir(candidate.id), 'cordis.patch.yml')
    baseline = await runOutOfProcess(settings, task, baselineCwd, signal)
    signal.throwIfAborted()
    changed = await runOutOfProcess(settings, task, changedCwd, signal, patchPath)
  }

  const hasVerify = candidate.verify !== undefined && candidate.verify.trim() !== ''
  let verifyDetail = ''
  if (hasVerify && candidate.verify !== undefined) {
    const baselineCheck = await runVerify(candidate.verify, baselineCwd, settings.timeoutMs)
    const changedCheck = await runVerify(candidate.verify, changedCwd, settings.timeoutMs)
    baseline = { ...baseline, passed: baselineCheck.passed }
    changed = { ...changed, passed: changedCheck.passed }
    verifyDetail = [
      `baseline: ${baselineCheck.passed ? 'pass' : 'fail'}`,
      `changed: ${changedCheck.passed ? 'pass' : 'fail'}`,
      baselineCheck.detail,
      changedCheck.detail,
    ].filter(part => part !== '').join('\n')
  }

  let decided = verdictOf(hasVerify, baseline.passed, changed.passed)
  let judgement: JudgeOutcome | undefined
  if (!hasVerify && settings.judge === 'rubric') {
    judgement = await judge({
      ctx,
      provider: settings.provider,
      parent: agent,
      task,
      baseline,
      changed,
      cwd: changedCwd,
      signal,
    })
    const scored = judgement.score
    decided = scored === undefined
      ? { verdict: 'needs-review', reason: `No deterministic check, and the judge produced no score: ${judgement.error ?? 'unknown reason'}.` }
      : {
          verdict: scored.verdict,
          reason: `No deterministic check; a rubric read scored the current harness ${String(scored.baseline)}/5 and the candidate ${String(scored.changed)}/5. ${scored.reason}`,
        }
  }

  const result: ProbeResult = {
    runId,
    candidateId: candidate.id,
    mode,
    task,
    verdict: decided.verdict,
    reason: decided.reason,
    baseline,
    changed,
    ...(judgement === undefined ? {} : { judge: judgement }),
    startedAt,
    finishedAt: new Date().toISOString(),
  }

  await store.ensure()
  await mkdir(runDir, { recursive: true })
  await writeJson(join(runDir, 'result.json'), result)
  await writeFile(join(runDir, 'report.md'), renderReport(result, candidate, verifyDetail, judgement), 'utf8')
  return result
}

/** Rows for the first-turn token table, or a note when neither side reported usage. */
function tokenRows(result: ProbeResult): string[] {
  const { baseline, changed } = result
  if (baseline.promptTokens === undefined && changed.promptTokens === undefined) {
    return ['_Neither side reported usage; the provider gave no sample._']
  }
  const cell = (value: number | undefined): string => value === undefined ? 'not reported' : String(value)
  return [
    '| side | input tokens |',
    '| --- | --- |',
    `| baseline | ${cell(baseline.promptTokens)} |`,
    `| changed | ${cell(changed.promptTokens)} |`,
  ]
}

function renderReport(result: ProbeResult, candidate: Candidate, verifyDetail: string, judgement?: JudgeOutcome): string {
  return [
    `# Probe ${result.runId}`,
    '',
    `- candidate: \`${candidate.id}\` (${candidate.title})`,
    `- lever: \`${candidate.lever}\``,
    `- mode: \`${result.mode}\``,
    `- verdict: **${result.verdict}**`,
    `- reason: ${result.reason}`,
    `- window: ${result.startedAt} → ${result.finishedAt}`,
    '',
    '## Task',
    '',
    '```text',
    result.task,
    '```',
    '',
    '## First turn',
    '',
    ...tokenRows(result),
    '',
    '## Deterministic check',
    '',
    verifyDetail === '' ? '_not declared; the verdict cannot be automated for this candidate._' : `\`\`\`text\n${verifyDetail}\n\`\`\``,
    '',
    '## Baseline (current harness)',
    '',
    result.baseline.error === undefined ? '' : `error: ${result.baseline.error}`,
    '',
    renderTrajectory(result.baseline.trajectory),
    '',
    '## Changed (candidate rows)',
    '',
    result.changed.error === undefined ? '' : `error: ${result.changed.error}`,
    '',
    renderTrajectory(result.changed.trajectory),
    '',
    ...(judgement === undefined ? [] : ['## Rubric read', '', renderJudge(judgement), '']),
    '## Read this before adopting',
    '',
    'One task is one observation. A verdict of `improved` means only that this candidate',
    'helped here; check it on a task the probe never saw before keeping it.',
    '',
  ].join('\n')
}
