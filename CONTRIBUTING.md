# Contributing

Thanks for looking. This project has an unusual constraint that shapes everything: **it changes the thing it runs in**. Read [docs/AUTONOMY.md](docs/AUTONOMY.md) before proposing a feature that increases what the loop may do on its own.

## Development

```bash
git clone https://github.com/miketako3/dsh-self-harness
cd dsh-self-harness
npm install
npm run typecheck
npm test
npm run build
```

Node 22 or newer. There is no bundler and no test framework dependency: tests run on `node --test` against the compiled output, so a passing `npm test` proves the artifact users get also builds.

## Where things live

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry: config, tool registration |
| `src/diagnose.ts` | Pure aggregation of session evidence into findings |
| `src/observe.ts` | Pure extraction of per-turn observations |
| `src/skills.ts` | Pure skill-candidate detection and rendering |
| `src/memory.ts` | Observation log, digest, journal, search |
| `src/guard.ts` | The protected surface |
| `src/probe.ts` | Two-sided execution and the verdict |
| `src/propose.ts`, `src/adopt.ts` | Candidate authoring and bundle production |
| `src/child.ts`, `src/sessions.ts` | Host seams: child agents, session reads |

Pure modules have no imports from the host and are tested with plain objects. If a change needs a DSH service, it belongs in the orchestration modules, not in `diagnose`, `observe`, or `skills`.

## What a good pull request looks like

- One behaviour per pull request, with the test that would fail without it.
- New guard rules come with a test proving the rejected shape, because a guard that silently stops guarding is worse than no guard.
- Anything that runs a candidate's code must keep it out of the host process.
- Public API changes to `Config` need a default that preserves current behaviour.

## Commit messages

Conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`), imperative mood, and a body that says what was wrong before. The body matters more than the subject.

## Reporting a bug that involves a probe

Include the run directory (`runs/<id>/`) with `result.json` and `report.md`, and the candidate's `candidate.json`. Redact anything from the trajectories you would not publish; the reports contain file excerpts and task text.

## Security

Do not open a public issue for anything in [SECURITY.md](SECURITY.md). Use a private advisory.
