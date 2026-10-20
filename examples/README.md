# Examples

Two candidate shapes, one for each way the loop can change a harness.

A candidate is a directory under `<baseDir>/candidates/<id>/` containing `candidate.json` and, optionally, `skills/` and `plugin/`. These files are what `fracture_propose` writes and what `fracture_probe` and `fracture_adopt` read.

## `prompt-addendum`: applied live

```json
{
  "prompt": "This repository uses pnpm. Run `pnpm test`, never `npm test`."
}
```

Only a candidate with `prompt` and no rows can be applied without a restart, because a running agent's preset cannot be re-bound. The text becomes an agent-scoped prompt section, and disposing that section is the revert. If the watch window says the numbers got worse, the loop reverts it and says so in the journal.

## `skill-recipe`: installed, or registered

```json
{
  "rows": [{ "name": "@deepseek-ai/dsh-skill-filesystem" }],
  "skills/…/SKILL.md": "…"
}
```

A row-shaped candidate cannot be applied to a live agent. It is probed in a child, and adoption produces a bundle that a human installs. The one exception is a skill file with no rows: the runtime registry accepts it, which is what the automatic distiller uses.

## Field reference

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Directory name; defaults to the directory it was found in. |
| `title` | yes | One line for the status view. |
| `rationale` | yes | Why this helps, tied to the finding. |
| `finding` | yes | Finding id from `fracture_diagnose`. |
| `lever` | yes | `prompt`, `skill`, `script`, `tool`, or `hook`. |
| `rows` | yes | Cordis rows to insert. May be empty for a prompt-only or skill-only candidate. |
| `verify` | no | Shell command that exits non-zero when the harness fails. |
| `prompt` | no | Prompt text that may be applied live. Under 4000 characters. |

Rows naming the approval policy, the sandbox policy, the plugin manager, or this plugin are rejected before storage and again before probing.
