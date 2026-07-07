# Run-liveness golden corpus — labeling method

**Owner:** Engineer · **Parent:** POS-82 (what "better" means for the harness) · **Task:** POS-171 (B2).

This corpus pins the behavior of `classifyRunLiveness`
(`server/src/services/run-liveness.ts`) — the pure function that decides, after a
heartbeat run succeeds, whether the run actually *advanced* the issue or merely
produced a green-looking signal. It is one of the "close the gap between a proxy
and real value" deliverables from the POS-82 plan: the classifier is the gate
that recovery/continuation logic trusts, so a silent loosening of it is exactly
the kind of regression the north-star work is meant to catch.

Files:

- `run-liveness-corpus.ts` — the labeled fixtures (`RUN_LIVENESS_CORPUS`) plus
  the pinned gaming holes (`RUN_LIVENESS_GAMING_HOLES`) and the per-state floors.
- `../run-liveness-corpus.test.ts` — drives `classifyRunLiveness` directly (pure
  function, no I/O) in the existing per-PR server vitest lane.

## The seven states (labeling rubric)

Labels are assigned against the definitions the classifier itself encodes
(`RUN_LIVENESS_STATES` in `packages/shared`), applied in the classifier's own
precedence order:

1. **failed** — the run process did not `succeed` (`failed` / `timed_out` /
   `cancelled` run status). Wins over everything, including partial text.
2. **completed** — the issue reached a terminal state (`done` / `cancelled`).
   Wins over blocker prose and empty output.
3. **blocked** — the issue is `blocked`, or the run declared a *concrete*
   external blocker (missing access/credential/secret/token/input) or an
   approval requirement.
4. **empty_response** — succeeded but produced no useful output and no concrete
   action evidence (including runs whose only output is shell/tool transcript
   noise, which is stripped before evaluation).
5. **advanced** — concrete action evidence exists (issue comments, document
   revisions, work products, activity events, or tool/action events), OR the
   issue is a planning/document task that produced useful output (exempt from
   plan-only). Workspace-setup operations alone do **not** count.
6. **plan_only** — useful output that describes *runnable* future work with no
   concrete evidence yet (safe for a bounded auto-continuation).
7. **needs_followup** — useful output that is **not** safe to auto-continue:
   ambiguous results, or next actions routed to manager review (e.g. production
   deploys, escalations).

## Provenance and why the fixtures are scrubbed

The B2 task calls for "~50 human-labeled real run transcripts exported from
`heartbeat_runs` / `heartbeat_run_events`." Each fixture here is modeled on the
*shape* of a real transcript observed across the fleet (empty runs that only
shelled around, planning-only acknowledgments, genuine credential blockers,
evidence-backed advances, inconclusive follow-ups), but:

- all identifiers, agent/company/issue ids, URLs, secrets, and PII are removed,
- prose is paraphrased, and
- **raw production run output is deliberately not committed.**

This is a hard boundary (no secrets/PII/scraped personal data in the repo), and
it costs nothing for correctness: `classifyRunLiveness` is a pure function over
a handful of text fields and integer evidence counts, so a scrubbed,
representative transcript exercises exactly the same code paths as the original.
When a de-identified real transcript is available it can be dropped straight into
`RUN_LIVENESS_CORPUS` with the same fields.

Every fixture was hand-labeled by the engineer using the rubric above; the label
is the ground truth, independent of what the classifier returns.

## Adversarial gaming fixtures

Two flavors:

- **Handled adversaries** live in the main corpus and assert the *correct*
  result — e.g. stale blocker prose on a `done` issue stays `completed`; a run
  whose only output is `command:`/`tool_call:` noise is `empty_response`; a
  durable comment out-ranks a dangerous raw-transcript "next action".
- **Known holes** live in `RUN_LIVENESS_GAMING_HOLES` and are pinned as
  vitest `it.fails` expectations that assert the *desired* (non-gameable)
  classification. The classifier does not yet produce it, so each pin is an
  expected failure today. A companion assertion documents what the classifier
  *currently* returns. When the classifier is tightened to close a hole, its
  `it.fails` pin flips to passing and vitest fails the now-incorrect expectation
  — forcing the pin and the fix to move together. That is how "classifier
  changes are measured against the holes."

Current pinned holes:

| id | gaming pattern | desired | currently |
| --- | --- | --- | --- |
| `gaming-boilerplate-ack` | pure wake acknowledgment, no work | `empty_response` | `needs_followup` |
| `gaming-fake-approval-blocker` | approval blocker claimed on a task that needs none | `needs_followup` | `blocked` |
| `gaming-vague-clarification` | vague "need clarification", no concrete question | `needs_followup` | `blocked` |
| `gaming-contentless-next-steps` | contentless "Next steps" theater | `needs_followup` | `plan_only` |

## Precision/recall floors

The test computes per-state precision and recall over the labeled corpus and
asserts each stays at or above a floor (`PRECISION_FLOOR` / `RECALL_FLOOR`).
Floors are set at `0.8–0.9`: the current classifier meets them at `1.0`, so the
gap is headroom for future de-identified additions with occasional label noise —
but it is tight enough that a single-state collapse trips a floor. A dedicated
test proves the floors have teeth: it feeds the corpus through a deliberately
loosened classifier (any non-empty run rubber-stamped as `advanced`, the classic
"green means done" regression) and asserts at least one floor is violated.

## Extending the corpus

1. Add a `RunLivenessCorpusCase` with a scrubbed input, a `note` describing the
   real transcript shape, and the human `expected` label (plus
   `expectedActionability` when it matters).
2. Run `npx vitest run src/__tests__/run-liveness-corpus.test.ts` from `server/`.
3. If a genuinely correct label lands below a floor, that is a real classifier
   gap — file it (or add it as a gaming hole), do not weaken the floor to hide it.
