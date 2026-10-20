# Design

This document records the decisions behind `dsh-self-harness`, including the options that were rejected. It assumes you have read the README.

## 1. The problem

An agent's harness decides most of its behaviour: which prompt sections exist, which tools are loaded, which skills can be found, which policies are enforced. Improving that harness is normally a manual, expert activity: you notice a bad pattern in transcripts, guess at a fix, ship it, and hope.

[Harness²](https://github.com/google-research/harness2) automates the loop for harnesses it owns: it declares every editable surface, versions the whole tree, and evaluates two harness versions against the same task. The approach works because the harness is inspectable and cheap to duplicate.

DSH already has the property that makes this practical, but for a different reason: a DSH harness is an ordered list of Cordis plugin rows. A preset is a row list. A bundle ships a row list. Editing a harness means inserting, replacing, or removing rows. There is no separate tree of editable files to maintain.

That is why this project does **not** vendor or fork Harness². The thing Harness² has to build (a declarative harness surface) is what DSH already is.

## 2. What is borrowed, what is not

| Harness² idea | Adopted | Why |
| --- | --- | --- |
| Judge a change by contrast on the same task | Yes | The only signal that survives a change of wording. |
| Lessons with cue, evidence, confidence | Yes, as append-only markdown | Cheap, readable, survives refactors. Confidence is expressed as the probe verdict. |
| Escalate from the weakest lever | Yes, as a documented ladder | A wrong prompt costs one probe; a wrong hook changes every tool call. |
| 4k + 3k rollout budget per task | No | DSH sessions are long-lived and interactive; a fixed rollout count does not transfer. Caps are per probe instead. |
| An eight-file editable tree (`systemprompt.md`, `guardrails.md`, `LongTermMEMORY.md`, skill and agent directories, scripts, plugins) | No | DSH's row list expresses the same edits with a loader, versioning, and dependency resolution already attached. |
| Library of harnesses under `library/<k>/<mode>/<domain>/` | Partly | `candidates/` plays the same role, keyed by candidate id rather than by recursion depth. |
| Python harness runtime | No | The shipped artifact must be a Node package that DSH can load. |

## 3. The loop

```text
self_diagnose  →  self_propose  →  self_probe  →  self_adopt
   evidence        candidate        contrast        artifact
```

Each arrow is a tool the model calls itself. There is no scheduler and no background loop: the user, or the model, decides when to advance. That keeps the loop auditable and avoids an agent that rewrites itself while nobody is watching.

### 3.1 Diagnose

Diagnosis is pure arithmetic over stored session events. It reports counts, not opinions:

- per-tool call and failure counts, ranked by failure ratio;
- repeated reads of the same path within one session;
- approval decisions that were rejected;
- history compaction count;
- message feedback ratings, when the feedback plugin records them;
- token totals, when the provider records usage on `assistant/message`.

Thresholds exist so that one unlucky failure never becomes a finding: a tool needs at least three calls and a thirty percent failure rate, a path needs three reads, denials need two.

Feedback is treated as trustworthy by default. A rating is a human statement about the answer, and a negative rating is the strongest cheap signal available. It is not, however, sufficient on its own: the finding still has to be explained by counts, because a rating cannot tell you what to change.

### 3.2 Propose

The proposer is a **subagent**, not the session that will live with the change. Two reasons:

1. Context isolation. The proposer can read the repository and the diagnosis without polluting the working session with an exploration transcript.
2. Accountability. The proposer writes files, and the parent validates them. A proposer that goes wrong produces a rejected candidate instead of a mutated harness.

The proposer cannot install anything. Its only output is a directory:

```text
candidates/<id>/
├── candidate.json      # rows, rationale, finding, lever, optional verify
├── skills/<name>/…     # optional
└── plugin/index.js     # optional
```

Validation happens in the parent, after the subagent returns: JSON shape, row count, and the protected surface check. A rejected candidate is reported with everything wrong at once, so a retry has something to work with.

### 3.3 Probe

This is the part that makes the loop worth running, and the part with the most constraints.

**Two sides.** The same task runs on the current harness and on the candidate. Both sides get the same prompt text, the same workspace contents, and the same tools. Only the candidate rows differ.

**Two execution paths.** The choice is forced by process isolation:

- A **rows-only** candidate (prompt section, skill directory, toggle, existing tool) runs as a child agent inside the DSH process. The rows reference modules that are already loaded, so nothing new is executed. Cost: seconds.
- A **code-bearing** candidate (`plugin/index.js`) runs as a separate `dsh` process with the generated patch as an overlay. Unverified code writes files, spawns processes, and registers tools; it must not share a process with the session that is judging it. Cost: a full boot.

The candidate directory records which path applies by whether `plugin/` exists.

**Workspace isolation.** Each side gets its own copy, because a probe task usually edits files. Copying `node_modules` and `.git` would dominate the cost, so those directories are symlinked back into the copy instead of being duplicated. Build output (`dist`, `build`, `.next`, `target`, and friends) is skipped; the loop's own base directory is excluded so a probe can never copy previous runs into itself.

**The verdict.** A deterministic check, when the candidate declares one, decides: it runs in both workspaces and the exit codes are compared. Without a check the verdict is `needs-review` and both trajectories are presented. This is deliberate: a rubric read by another model is a reasonable future addition, but shipping it before it is measured would put a noisy judge in the loop's most consequential position.

**The trajectory grammar.** Both sides render as `[ACTION]` / `[OBSERVATION]` pairs. The format is borrowed from Harness² as an idea, not as code: it makes two runs comparable by eye and by diff, which is the entire point of a probe.

### 3.4 Adopt

Adoption is separated from probing because a probe result is evidence, not permission.

- It refuses unless the newest probe for that candidate is `improved`, unless `force` is set.
- It produces a **bundle**: `cordis.patch.yml`, a `package.json` declaring `dsh.bundle.patch`, plus the candidate's `plugin/` and `skills/`.
- A probe-relative row (`name: "./plugin/index.js"`) is rewritten to the bundle package name. Same files, different loader.
- It appends one section to `lessons.md`.
- It does **not** install. Installing is `dsh plugin add` or the `plugin_manager` tool, and that approval is the human gate for self-modification.

Appending to a profile patch is available (`apply` plus `profilePatch`) for users who prefer to see the row list in their own configuration, but it is off by default.

## 4. The protected surface

The loop must not be able to change the rules that constrain it. `src/guard.ts` rejects any candidate row that mentions:

| Protected | Why |
| --- | --- |
| `dsh-user-approval` | A candidate that weakens approval makes every later candidate easier to adopt. |
| `dsh-sandbox-policy` | Same, for filesystem and process boundaries. |
| `plugin_manager` | A candidate that can install packages can install anything. |
| `dsh-self-harness` | The loop editing itself mid-flight has no stable subject. |

The check is name-based and therefore conservative: it rejects by substring, so a legitimate row whose id happens to contain "approval" is refused. That trade is intentional; a false rejection costs one proposal, a false acceptance costs the boundary.

## 5. Teardown

Two resources are owned by a probe and must never outlive it:

1. **The candidate preset.** `ctx.agentPresets.register()` returns a disposer; it is not an effect and nothing disposes it automatically. The probe holds the disposer and calls it in `finally`.
2. **The child agent.** `ctx.subagents.startActivation()` returns an activation whose `dispose()` reaches quiescence. The probe calls it in `finally`, after awaiting the result, and swallows teardown failures so they cannot mask a captured result.

A mount failure needs special handling: the preset registry records it as `broken` and resolves the registration anyway. A probe that skipped this check would run the *baseline* rows and report a result for a change that never loaded. The probe therefore reads the preset back and refuses if it is broken.

## 6. Measurements that exist, and ones that do not

DSH records more than a transcript, and the diagnosis uses that:

- tool calls and results, with error identity;
- approval decisions;
- compaction events;
- token usage per assistant message;
- message feedback, when installed.

Two things are deliberately not measured yet:

- **First-turn prompt tokens before and after adoption.** The design called for it, and `ctx.tokenMeter` can provide it, but the plugin does not wire it up. Until it does, an adopted prompt row's cost is unverified.
- **Rubric judging.** See 3.3.

## 7. Rejected alternatives

**Fork DSH and patch the loop in.** Rejected: the artifact would age against a moving target and users could not install it.

**Vendor Harness² and translate between formats.** Rejected: two harness vocabularies, no benefit. The runtime is Python and the shipped artifact must be Node.

**Let the proposer apply its own candidate after a good probe.** Rejected: it moves the human gate from "install this code" to "trust this model's summary", which is exactly the trade the security model avoids.

**Run both probe sides concurrently.** Rejected for now: two child agents competing for the same model quota make latency comparison meaningless and complicate teardown. Sequential is slower and easier to explain.

**Use the `subagent` tool instead of calling the subagent service directly.** Not possible for presets: the tool's `allowedAgentPresets` is resolved at load time, so a preset registered at runtime is not admitted. The loop calls `ctx.subagents.startActivation()` itself.

## 8. Open work

- Wire `ctx.tokenMeter` into probe reports so a prompt growth is visible per side.
- Add a rubric judge behind a config flag, with the deterministic check always taking precedence.
- Report probe cost (wall clock, tokens) in `result.json` once metering exists.
- Publish candidates as a shareable library, keyed by domain rather than by id.
