# dsh-self-harness

A self-improvement loop for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), shipped as a DSH plugin.

The agent reads its own session history, diagnoses what its harness is doing badly, has a subagent write a candidate harness edit, **runs the same task twice** — once on the current harness, once with the candidate — and only then decides whether to keep the change.

English | [日本語](README.ja.md)

```text
self_diagnose ──► self_propose ──► self_probe ──► self_adopt
     │                │                 │              │
 session log      candidate.json    two runs       bundle +
   evidence        + rows/files     compared       lesson
```

Nothing here edits a running profile on its own. Every step writes files you can read, diff, and delete, and installing host code stays a human-approved action.

## Why this shape

DSH composes an agent from an ordered list of Cordis plugin rows. A harness is therefore **data**, not code: adding a prompt section, a skill directory, a tool, or a policy is an edit to a row list. That makes the interesting operation cheap — you can hold two harnesses at once, run the same task on both, and compare.

Three ideas are borrowed from [Harness²](https://github.com/google-research/harness2) (Google Research, Apache-2.0):

- **Contrast beats introspection.** A harness edit is judged by running the same task on the old and new harness, not by asking a model whether the edit sounds good.
- **Lessons accumulate with evidence.** Each adoption appends a cue, the change, the probe verdict, and a rationale to `lessons.md`.
- **Escalate from the weakest lever.** Prompt before skill, skill before script, script before tool, tool before hook.

Harness²'s eight-file harness tree is deliberately *not* adopted; DSH's row list already is that tree, with a loader.

## Install

```bash
dsh plugin --profile web add dsh-self-harness   # or: pnpm add in the profile directory
```

Then restart the session. The plugin registers five tools and needs no configuration to start.

Configuration lives in the profile patch:

```yaml
- id: self-harness
  name: dsh-self-harness
  config:
    baseDir: .dsh/self-harness      # where candidates, runs, and lessons live
    provider: spawn                 # subagent provider for proposer and in-process probes
    dshCommand: dsh                 # binary used for out-of-process probes
    profile: headless               # profile an out-of-process probe boots
    timeoutMs: 900000               # per child run
    isolate: true                   # copy the workspace per probe side
    maxSessions: 12                 # sessions per diagnosis
    packagePrefix: dsh-self-harness-candidate
    profilePatch: ""                # profile patch that self_adopt may append to
```

## Quick start

Ask the agent, in a session inside the repository you want it to work on:

```text
Run self_diagnose, pick the strongest finding, then self_propose for the task
"add a test to the pagination module". Probe the candidate before adopting it.
```

Or drive it yourself, one step at a time:

| Tool | What it does |
| --- | --- |
| `self_diagnose` | Reads the newest sessions and ranks findings: tool failure rates, repeated reads of one file, rejected approvals, compaction pressure, message feedback. Saves a snapshot. |
| `self_propose` | Sends a proposer subagent that writes `candidates/<id>/candidate.json` plus optional `skills/` and `plugin/`. Every candidate is validated before it is accepted. |
| `self_probe` | Runs one task on the current harness and on the candidate, in separate workspace copies, and compares trajectories and a deterministic check. Writes `runs/<id>/report.md`. |
| `self_adopt` | Turns a probed candidate into an installable bundle and appends the lesson. Refuses anything that did not probe as `improved` unless forced. |
| `self_status` | Lists candidates with the verdict of their newest probe. |

A candidate is small on purpose:

```json
{
  "id": "read-before-edit",
  "title": "Require a read before editing an existing file",
  "rationale": "The editor failed 6 of 9 times on files the agent had not opened.",
  "finding": "tool-failures:edit",
  "lever": "prompt",
  "verify": "pnpm test",
  "rows": [
    {
      "id": "system-prompt",
      "name": "@deepseek-ai/dsh-system-prompt",
      "config": { "personaSuffix": "Always read a file before editing it." }
    }
  ]
}
```

At most three rows per candidate, so that the probe can attribute an effect.

## What gets written

```text
.dsh/self-harness/
├── diagnoses/2026-10-20T02-11-08-471Z.json   # one snapshot per diagnosis
├── candidates/read-before-edit/
│   ├── candidate.json                        # source of truth
│   ├── cordis.patch.yml                      # generated, for humans
│   ├── skills/…, plugin/…                    # optional artifacts
│   └── bundle/                               # created by self_adopt
├── runs/2026-10-20T02-14…-read-before-edit/
│   ├── baseline/, changed/                   # workspace copies
│   ├── result.json
│   └── report.md                             # both trajectories, verdict, caveat
└── lessons.md                                # append-only
```

Nothing is hidden in a database. Delete the directory and the loop forgets everything.

## Security model

The loop is an agent editing the harness that runs it, so the design assumes that is dangerous.

- **The approval surface is not editable.** Candidates touching `dsh-user-approval`, `dsh-sandbox-policy`, `plugin_manager`, or `dsh-self-harness` are rejected before they are stored.
- **Unverified code never loads in the judging process.** A candidate that ships a plugin is probed in a separate `dsh` process against a generated patch. Only rows that reference already-loaded modules run in-process.
- **Adoption does not install.** It produces a bundle plus instructions. Installing that bundle is `dsh plugin add` or the `plugin_manager` tool, whose per-call approval is the human gate.
- **Probe runs are isolated.** Each side gets its own workspace copy; `node_modules` and `.git` are symlinked rather than copied.
- **Rollback is subtraction.** Remove the bundle or its rows; there is no state to unwind.

## Limits worth knowing

- A probe is **one task on one harness pair**. `improved` means it helped here. Re-run on a task the probe has not seen before adopting.
- Without a `verify` command the verdict is `needs-review`: both trajectories are shown and a human or rubric decides. Do not mistake that for evidence.
- Diagnosis reads what sessions record. A tool that fails silently, or a harness problem that only shows up as slow answers, will not appear as a finding.
- Out-of-process probes need a working `dsh` on `PATH` and a profile that can boot without interaction. Headless has no approval answerer, so a probe task that needs approval will fail closed by design.
- Cost is two rollouts plus one diagnosis per candidate. Budget accordingly and keep candidates small.

## Prior art

- [Harness²](https://github.com/google-research/harness2) — recursive agent harnessing via editable harness surfaces. The contrast-based evaluation, the lesson accumulation, and the weakest-first escalation come from there. This project reuses the ideas, not the code.
- Cordis and DSH's composition model, which makes a harness a declarative row list in the first place.

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs node --test
npm run build
```

Source layout: `src/diagnose.ts` and `src/trajectory.ts` are pure and tested without a host; `src/probe.ts`, `src/propose.ts`, and `src/adopt.ts` orchestrate the loop; `src/index.ts` registers the tools.

Design notes, including why Harness² is not vendored: [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
