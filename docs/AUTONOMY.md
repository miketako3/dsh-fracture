# Autonomy

v0.1 shipped a toolkit: the model calls `fracture_diagnose`, `fracture_propose`, `fracture_probe`, `fracture_adopt`. That is assisted improvement. What follows is the design for the part that runs without being called, and the boundaries it may not cross.

This document defines the next shape: a plugin that **runs by itself** — accumulating memory, distilling skills, and changing the harness without being asked — and the boundaries that keep that autonomy from being a liability.

Status: tiers 0, 1, and the prompt part of tier 2 are implemented. Tier 2 is limited to candidates carrying `prompt` text, because a running agent's preset cannot be re-bound. Tier 3 exists as the manual loop plus the automatic authoring note. Section 8 is the source of truth.

## 1. The problem with "just run the loop on a timer"

An agent that rewrites the harness producing its next answer has two failure modes that a human-in-the-loop toolkit does not have:

1. **Compounding error.** A change that looks fine in isolation degrades behaviour, and the next loop reads the degraded transcripts as evidence for another change.
2. **Loss of accountability.** Nobody asked for the change, so nobody notices it. Silent mutation is worse than no mutation.

Both are solved by the same move: make the blast radius of each change proportional to how reversible it is, and make every change visible.

## 2. Autonomy tiers

Four tiers, ordered by how much of the running system they can affect.

| Tier | What changes | Probe | Approval | Reversible by |
| --- | --- | --- | --- | --- |
| T0 | Memory: observations, digests, notes | none | none | deleting files |
| T1 | Skills: `skills/<slug>/SKILL.md` | none | none | deleting a file |
| T2 | Composition: prompt rows, skill-dir rows, tool toggles | required | none, but auto-reverted on regression | removing a row |
| T3 | Code: new plugin module, hook, UI | required | **human** | removing the bundle |

T0 and T1 are *additive knowledge*. They cannot execute, cannot widen permissions, and cannot change what the agent is allowed to do. Autonomy there is safe by construction, so they run without asking.

T2 changes behaviour, so it needs evidence (a probe) and a watch window (section 5). It still runs without asking, because it is a data change that the plugin itself owns and can undo.

T3 changes what code runs in the host process. The loop may **author** it automatically, and may **probe** it automatically, but installing it is a human decision. This is the one place where "automatic" stops, and the reason is not caution: an automatic installer would make the loop the most privileged actor in the system, which is exactly the surface an attacker would target.

## 3. What "automatic" means per tier

### T0: observe, always

Every turn appends one line to `memory/observations.jsonl`:

```json
{"at":"2026-10-20T03:02:11Z","session":"…","turn":12,"task":"add a test to pagination","tools":{"read":3,"edit":2,"bash":4},"failures":[{"tool":"edit","code":"FILE_NOT_SEEN"}],"corrected":true,"durationMs":41000}
```

No model call. This is the raw material for everything else, and it is why the loop can act on evidence rather than on a guess.

When 20 new observations accumulate, or a session closes, a summarizer subagent compresses them into `memory/MEMORY.md`: what the user is working on, what keeps failing, which procedures worked. The summarizer is a child agent, so it costs one rollout and leaves nothing in the working session's context.

Recall has two paths:

- a **prompt section** listing memory and skill titles, capped at 400 tokens, so the agent knows what exists;
- a **`memory_search` tool** that greps the store and returns matches.

The index is deliberately small. Dumping memory into the prompt is how a self-improving agent becomes a self-bloating one.

### T1: distill, on repetition

A procedure becomes a skill when it repeats **and** succeeds. Detection is arithmetic over observations:

- the same tool sequence (or the same task verb + file family) appears at least three times;
- the runs completed without a tool error and without a user correction;
- the sequence is not a one-liner already covered by an existing tool description.

At that point the distiller writes `skills/<slug>/SKILL.md` with a frontmatter name, a one-line description, and the procedure. No probe: nothing executes.

Whether a written skill becomes *active* depends on how skills are discovered. If the runtime supports adding a root or rescanning, the skill is live immediately. If discovery is load-time only, the plugin exposes the skill through its own index and read tools, and the next restart activates it natively. Section 8 records which applies.

### T2: compose, with evidence and a watch window

The T2 path is the v0.1 loop, run by the plugin instead of by the model:

diagnose → propose (subagent) → probe (two rollouts) → decide → apply or drop.

Additional conditions before a T2 change is applied:

- at least one finding crosses its threshold, so the loop never invents work;
- the probe verdict is `improved`, or `no-change` with a strict improvement in the trajectory (fewer tool errors, fewer steps);
- the applied change is recorded with the configuration it replaced;
- the watch window opens (section 5).

Applying means the plugin re-composes its own layer: the rows live in a file the plugin owns, and the plugin mounts them as a child context. The running session sees the new behaviour on its next request, not after a restart. Where that is not possible, the change is written and marked pending, and the plugin says so instead of pretending.

### T3: author, never install

The loop can write a plugin, validate that it parses, probe it out of process, and produce a bundle. It then posts a message into the session:

> authored `candidate-7` (hook: deny edits to files not read in this session). Probe: improved. Bundle at `.dsh/fracture/candidates/candidate-7/bundle`. Install with `dsh plugin --profile web add <path>`, or run `fracture_adopt` to stage it.

That message is the handoff. The human gate is one command, not a research project.

## 4. Triggers

| Trigger | Tier allowed | Cadence |
| --- | --- | --- |
| Turn end | T0 | every turn |
| N turns elapsed (default 8) | T1, T2 | at most once per window |
| Session close | T0 summary, T1 | once per session |
| Idle timer (default 15 min) | T1, T2 | only while no turn is in flight |
| Manual tool | any | on request |

Rules that prevent the loop from fighting the user:

- never start a T2 probe while a turn is in flight;
- at most one loop in flight at a time;
- after applying a T2 change, wait for a full watch window before another T2 change;
- on two consecutive internal failures, downgrade autonomy to `memory` and write the reason to the journal.

## 5. The watch window

Every applied T2 change opens a window (default: 12 turns or 30 minutes).

- Record the metrics of the last 12 turns before the change: tool failure rate, mean steps per turn, first-turn prompt tokens, user corrections.
- At the end of the window, compare. Revert if the failure rate rose by more than 5 points, steps rose by more than 25 percent, or prompt tokens rose by more than 15 percent for a prompt-row change.
- A revert is itself a change: it is recorded, announced, and counted. Two reverts in a row disable T2 for the session.

The point is not to prove the change was good. It is to make a bad change cost one window instead of a week.

## 6. Visibility

Autonomy without visibility is how trust dies. Every automatic action produces:

- one line in `journal.md`, append-only;
- one compact message in the session for anything above T0 (`applied`, `reverted`, `authored`, `skipped: budget`);
- a `fracture_status` view that shows the current tier, the last five actions, the open watch window, and the budget remaining.

T0 actions stay in the journal only. A message per memory update would be noise.

## 7. Budget

| Knob | Default | Why |
| --- | --- | --- |
| `maxLoopsPerHour` | 2 | three rollouts per loop, so this caps spend at six rollouts per hour |
| `maxProbesPerHour` | 1 | a probe is the expensive part |
| `minTurnsBetweenLoops` | 8 | no loops on a two-turn session |
| `maxTokensPerLoop` | 120k | stop a loop that is going nowhere |
| `autonomy` | `full` | `off`, `memory`, `skills`, `full` |

When the budget is exhausted the loop says so once, then goes quiet until the window rolls over.

## 8. Implementation status

Filled in as each tier lands. Until a row is marked done, treat the tier as design.

| Piece | Status |
| --- | --- |
| Observation log | **done** — `src/observe.ts`, `src/autopilot.ts`, driven by `session/event` at `turn/end` |
| Memory digest | **done, deterministic** — counts and rankings, rewritten every `digestEvery` turns; a subagent-written prose digest is not wired |
| Memory index section and search tool | **done** — dynamic `systemPrompt.section` (order 9900, `interpolate: false`) plus the `memory_search` tool |
| Skill distiller | **done** — three clean repetitions of a two-step procedure; hand-written skills are never overwritten |
| Live skill registration | **done** — `agent.ctx.skills.register`, reconciled when the distiller writes a file |
| Probe-gated T2 apply | **done for prompt-only candidates** — `src/apply.ts` registers an agent-scoped section after an `improved` verdict; a row-shaped candidate is refused with the reason |
| Watch window and auto-revert | **done** — `Autopilot.openWatch` records the baseline, `evaluateWatch` compares the turns that followed, and the plugin disposes the section on a revert |
| Session notifications | **done** — `src/notice.ts` injects a `fracture` source kind with `form: 'notice'`, which renders as a collapsed context row and does not start a turn |
| Budget accounting | **done** — `src/policy.ts` counters, consulted by `src/autoloop.ts` before a loop and enforced by `Autopilot.noteLoop` / `noteProbe` / `noteFailure` |
| T3 authoring with handoff message | the manual loop does this; the handoff message is the tool's return text |
| Unattended loop | **done** — `src/autoloop.ts` gates it and the 15 minute idle trigger or `fracture_loop` runs it; requires a repeated task and a finding above `low` |

### The shape of an automatic apply

A row cannot be inserted into a running agent, so the automatic path is narrower than the design first assumed:

1. The candidate must carry `prompt` text and no rows. `applyability()` returns the reason when it does not.
2. The text becomes a section named `fracture:candidate:<id>` at order 9950, above the memory index, below the tool descriptions.
3. The watch window opens with the metrics of the last `watchTurns` turns as its baseline.
4. When the window is due, the turns recorded since `appliedAtIso` are compared. A failure rate rise above 5 points, mean steps above 25 percent, or prompt tokens above 15 percent disposes the section.
5. The revert is journaled and counted; two in a row park composition changes for the session.

Anything larger than a prompt addition stays a bundle. That is not a limitation of the implementation but of the host contract: `mount` binds a preset to a blank session, and re-binding one that already ran corrupts it.

### Notes from the host research

These are the facts the implementation depends on, recorded because they are not obvious from the API surface:

- Sections are re-rendered at every `assemble()` in `preStep`, so a section whose `text` is a function is live. A section with static text is not.
- `complete: true` on any section makes every waterfall addition unreachable, silently. This plugin never sets it.
- `ctx.skills.register` is first-wins per name, returns its own disposer, and bumps a registry revision that clears every provider's cache. Reconcile diffs, never register per step.
- Registering into `agent.ctx` scopes the skill to that agent; registering on the plugin's own context makes it global.
- A running agent's *composition* cannot be re-bound to a different preset; its *next request* is assembled fresh every step. Per-agent registration is the supported live path, and it is the one used here.
- `agent.followup` wakes an idle agent and starts a turn; `agent.inject` does not. Notices use `inject`, so the loop never manufactures a turn of its own. A message whose `source.kind` is not `user` is projected as context, not as something the human typed, and `form: 'notice'` with a bounded `summary` collapses it to one line.

## 9. Why not full autonomy

A plausible reading of "automatic" is: let the loop install its own code too. That would make `dsh-fracture` a program that can rewrite itself without a human, and the first genuinely bad change would be unfalsifiable from inside the system. The tiers above exist because the useful part of autonomy (memory, skills, prompt-level composition) does not require that power, and the dangerous part is a single command away.

If someone wants it anyway, the honest way to offer it is a config flag that requires an explicit acknowledgement file in the base directory, not a default.
