# Roadmap

Ordered by what makes the loop trustworthy, not by what is fun to build.

## v0.2 — autonomous observation

The loop stops waiting to be asked.

- [ ] Turn-end observation log, no model call
- [ ] Memory digest rewritten by a summarizer subagent at session close
- [ ] Distilled skills written to `skills/`, never overwriting a hand-written file
- [ ] Session notifications for anything above memory
- [ ] Budget accounting and a self-downgrade after repeated internal failures

## v0.3 — autonomous composition

The prompt-level part of the harness changes without a human.

- [ ] Probe-gated apply of rows that introduce no new code
- [ ] Watch window with automatic revert on regression
- [ ] First-turn prompt token measurement before and after a change
- [ ] Rubric judging behind a flag, with the deterministic check always taking precedence

## v0.4 — the part people can see

- [ ] `dsh-fracture` status panel in the web UI, once the client-plugin surface is settled
- [ ] Shareable candidate library, keyed by domain
- [ ] `dsh fracture` subcommand for the same operations outside a session

## Explicitly not planned

- **Automatic installation of code.** The loop may author and probe a plugin; installing it stays a human decision. See [docs/AUTONOMY.md](docs/AUTONOMY.md) section 9.
- **A hosted service.** Everything runs locally, against your own sessions.
- **Model-side fine-tuning.** This learns a harness, not weights.

## How to influence this

Open a candidate issue with the evidence you have. Roadmap items move when someone shows the loop failing in a way the item would fix.
