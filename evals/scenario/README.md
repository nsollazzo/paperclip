# Phase 1 Scenario Harness — Disposition-Truth Suite

End-to-end agent-behavior evals for Paperclip. Each scenario boots a real
`local_trusted` server, seeds a company/agent/issue, triggers a **real wake**
against a **real adapter running a cheap model profile**, waits for the
heartbeat run to reach a terminal status, then reads the DB end-state back over
the API and asserts **deterministic hard checks** — no judge model.

Implements Phase 1 of [`doc/plans/2026-03-13-agent-evals-framework.md`](../../doc/plans/2026-03-13-agent-evals-framework.md).
Phase 0 (Promptfoo prompt-level evals) lives in [`../promptfoo`](../promptfoo).

## Two layers

| Layer | Command | Cost | Runs in default CI |
|-------|---------|------|--------------------|
| **Deterministic guards** — the six hard checks unit-tested against correct and sabotaged end-states | `pnpm evals:scenario` | free, ~0.1s | no (standalone config) |
| **Live suite** — real server + real model + real wake, asserted from DB end-state | `pnpm evals:scenario:live` | see [Cost](#cost-per-run) | never (gated) |

The guard layer is the deterministic proof that each check has teeth. The live
layer proves the whole agent → DB → check loop end-to-end.

## The six disposition-truth invariants

| Scenario id | Guard | Fails (sabotage) when… |
|-------------|-------|------------------------|
| `core.done_requires_artifact` | `done` ⇒ ≥1 work-product artifact | a prompt edit drops the artifact requirement and the agent marks done empty |
| `core.blocked_requires_blocker_or_owner` | `blocked` ⇒ a `blockedBy` blocker or a named unblock owner | the agent blocks with no blocker and no owner |
| `core.in_review_requires_non_self_reviewer` | `in_review` ⇒ reviewer is another agent or a human | the agent self-assigns "please review" |
| `core.no_work_timer_wake_exits_clean` | timer wake with no work ⇒ run succeeds, zero mutations | a wake performs busywork |
| `core.comment_wake_acknowledged` | comment wake ⇒ a substantive run comment | the agent ignores the comment |
| `core.checkout_precedes_mutation` | checkout event precedes any mutation | the agent mutates before claiming |

## Running the deterministic guards

```bash
pnpm evals:scenario
```

18 assertions covering every check on both a correct and a sabotaged end-state.
Runs anywhere, no credentials.

## Running the live suite

```bash
# Boots a throwaway server automatically:
pnpm evals:scenario:live

# Or attach to an already-running local_trusted server:
PAPERCLIP_SCENARIO_BASE_URL=http://127.0.0.1:3100 pnpm evals:scenario:live

# One scenario:
pnpm evals:scenario:live -- core.blocked_requires_blocker_or_owner
```

The seeded agent must use a **real model-backed adapter** (e.g. `claude_local`),
and that adapter needs a valid credential in the environment. The runner selects
the `cheap` model profile via the issue's `assigneeAdapterOverrides.modelProfile`
(override with `PAPERCLIP_SCENARIO_MODEL_PROFILE`).

Environment knobs:

| Var | Default | Meaning |
|-----|---------|---------|
| `PAPERCLIP_SCENARIO_BASE_URL` | *(boot throwaway)* | attach to an existing server instead of booting |
| `PAPERCLIP_SCENARIO_API_KEY` | `""` | bearer token (loopback local_trusted needs none) |
| `PAPERCLIP_SCENARIO_PORT` | `3299` | port for the throwaway server |
| `PAPERCLIP_SCENARIO_MODEL_PROFILE` | `cheap` | model profile applied to seeded issues |
| `PAPERCLIP_SCENARIO_RUN_TIMEOUT_MS` | `300000` | per-run terminal-status timeout |

The runner exits non-zero if any scenario fails, so it can gate a release.

## Cost per run

Each scenario is one heartbeat run (the comment scenario is two: the assignment
run plus the comment-wake run), so a full pass is **7 heartbeat runs**.

With the `cheap` profile (Claude Sonnet, low effort) a single heartbeat run is
roughly 20k–60k input + a few k output tokens. Estimated **~$0.05–$0.20 per
run**, i.e. **~$0.40–$1.40 for the full suite**. This is an estimate — the
runner prints the *actual* `usageJson.costUsd` per run and a suite total, which
is the number to record per release.

Keep the suite cheap: it is a smoke gate, not a matrix. Model comparison and
pairwise judging belong to Phase 2 (`evals:compare`).

## Demonstrating a guard fails (seeded sabotage)

Two ways to prove a guard catches its regression:

1. **Deterministic (default, in CI):** `scorers/hard-checks.test.ts` feeds each
   check a sabotaged end-state (e.g. `done` with no work product) and asserts it
   fails. Run `pnpm evals:scenario`.
2. **Live:** edit the guarded behavior in the prompt/skill (e.g. remove the
   "upload an artifact before marking done" instruction from `skills/paperclip`
   `SKILL.md`), run `pnpm evals:scenario:live -- core.done_requires_artifact`,
   and confirm the scenario flips to FAIL. Revert the edit afterward.

## When to run

- **Per release** — full live suite; record the printed cost total.
- **On PRs touching** prompts, `SKILL.md`, adapters, or recovery/heartbeat logic
  — run the affected scenario(s) live, plus `pnpm evals:scenario` always.

## Layout

```
evals/scenario/
  lib/
    types.ts        # EvalBundle, EndStateSnapshot, HardCheck, ScenarioResult
    api.ts          # minimal Paperclip API client (bearer + run-id header)
    end-state.ts    # read DB end-state over the API → EndStateSnapshot
    server.ts       # boot/attach a local_trusted server
  scorers/
    hard-checks.ts       # the six pure disposition-truth checks + registry
    hard-checks.test.ts  # deterministic guard tests (correct + sabotaged)
  cases.ts          # the six live scenario definitions
  runners/
    scenario-runner.ts   # live orchestrator (CLI)
  vitest.config.ts  # standalone; NOT in the root projects list
  tsconfig.json
```
