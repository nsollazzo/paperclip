import type {
  RunLivenessActionability,
  RunLivenessClassificationInput,
} from "../../services/run-liveness.ts";
import type { RunLivenessState } from "@paperclipai/shared";

// Golden corpus for the run-liveness classifier (POS-82 · B2).
//
// Provenance & labeling method: see ./run-liveness-corpus.md. In short: each
// `real` fixture is modeled on the shape of an actual `heartbeat_runs` /
// `heartbeat_run_events` transcript observed across the fleet, with all
// identifiers, secrets, and PII scrubbed and prose paraphrased — raw production
// run output is deliberately NOT committed (secrets/PII boundary). Every fixture
// was hand-labeled by the engineer against the seven `RunLivenessState`
// definitions documented in the companion markdown. `real` fixtures are cases
// the classifier is expected to get right; `gaming` fixtures are known holes
// pinned as expected-fail so classifier changes are measured against them.

export interface RunLivenessCorpusCase {
  /** Stable id, used in failure output. */
  id: string;
  /** One-line description of the transcript shape this models. */
  note: string;
  input: RunLivenessClassificationInput;
  /** Human-assigned ground-truth liveness state. */
  expected: RunLivenessState;
  /** Optional ground-truth actionability, asserted when present. */
  expectedActionability?: RunLivenessActionability;
}

export interface RunLivenessGamingHole {
  id: string;
  /** Why this input games a green signal the classifier should not grant. */
  note: string;
  input: RunLivenessClassificationInput;
  /** The state a non-gameable classifier SHOULD return. */
  desired: RunLivenessState;
  /** The state the current classifier actually returns (the hole). */
  currentlyReturns: RunLivenessState;
}

const ISSUE = {
  status: "in_progress" as const,
  title: "Implement feature",
  description: "Add the requested behavior.",
};

function base(over: Partial<RunLivenessClassificationInput>): RunLivenessClassificationInput {
  return {
    runStatus: "succeeded",
    issue: ISSUE,
    resultJson: null,
    issueCommentBodies: null,
    continuationSummaryBody: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    error: null,
    errorCode: null,
    continuationAttempt: 0,
    evidence: null,
    ...over,
  };
}

const EVIDENCE_AT = new Date("2026-05-12T09:30:00Z");

// ---------------------------------------------------------------------------
// Real, expected-correct corpus (~50 cases, spread across all seven states).
// ---------------------------------------------------------------------------
export const RUN_LIVENESS_CORPUS: RunLivenessCorpusCase[] = [
  // --- failed: process did not succeed --------------------------------------
  {
    id: "failed-session-poisoned",
    note: "Run crashed with a poisoned adapter session.",
    input: base({ runStatus: "failed", errorCode: "session_poisoned", error: "adapter session invalid" }),
    expected: "failed",
  },
  {
    id: "failed-timed-out",
    note: "Heartbeat exceeded the wall-clock budget.",
    input: base({ runStatus: "timed_out" }),
    expected: "failed",
  },
  {
    id: "failed-cancelled-run",
    note: "Run cancelled mid-flight by the operator.",
    input: base({ runStatus: "cancelled" }),
    expected: "failed",
  },
  {
    id: "failed-oom",
    note: "Adapter process OOM-killed.",
    input: base({ runStatus: "failed", error: "worker terminated: out of memory" }),
    expected: "failed",
  },
  {
    id: "failed-gateway-503",
    note: "Inference gateway 503 storm aborted the run.",
    input: base({ runStatus: "failed", errorCode: "upstream_503" }),
    expected: "failed",
  },
  {
    id: "failed-timeout-with-partial-text",
    note: "Timed out after emitting partial output; status still wins.",
    input: base({
      runStatus: "timed_out",
      resultJson: { summary: "Started reading the schema" },
      continuationAttempt: 2,
    }),
    expected: "failed",
  },

  // --- completed: issue reached a terminal state ----------------------------
  {
    id: "completed-merged",
    note: "Issue marked done after a merge.",
    input: base({ issue: { ...ISSUE, status: "done" }, resultJson: { summary: "Implemented and merged the change." } }),
    expected: "completed",
  },
  {
    id: "completed-cancelled",
    note: "Issue cancelled as won't-fix.",
    input: base({ issue: { ...ISSUE, status: "cancelled" }, resultJson: { summary: "Closing as won't fix per the CEO." } }),
    expected: "completed",
  },
  {
    id: "completed-done-with-evidence",
    note: "Done issue that also produced evidence — terminal state still wins.",
    input: base({
      issue: { ...ISSUE, status: "done" },
      resultJson: { summary: "Shipped." },
      evidence: { issueCommentsCreated: 1, workProductsCreated: 1, latestEvidenceAt: EVIDENCE_AT },
    }),
    expected: "completed",
  },
  {
    id: "completed-done-empty-output",
    note: "Done issue with no final text — terminal state precedes empty check.",
    input: base({ issue: { ...ISSUE, status: "done" } }),
    expected: "completed",
  },
  {
    id: "completed-done-despite-blocker-prose",
    note: "Stale blocker prose on a done issue must not re-open it.",
    input: base({
      issue: { ...ISSUE, status: "done" },
      resultJson: { summary: "Earlier I was blocked waiting on credentials, but it is now finished." },
    }),
    expected: "completed",
  },
  {
    id: "completed-cancelled-superseded",
    note: "Issue cancelled because a sibling superseded it.",
    input: base({ issue: { ...ISSUE, status: "cancelled" } }),
    expected: "completed",
  },

  // --- blocked: real external / approval blocker (or blocked status) --------
  {
    id: "blocked-status",
    note: "Issue already carries blocked status.",
    input: base({ issue: { ...ISSUE, status: "blocked" }, resultJson: { summary: "Standing by for the dependency." } }),
    expected: "blocked",
  },
  {
    id: "blocked-need-credentials",
    note: "Cannot proceed without missing API credentials.",
    input: base({ resultJson: { summary: "I cannot proceed because I need API credentials for the upstream service." } }),
    expected: "blocked",
    expectedActionability: "blocked_external",
  },
  {
    id: "blocked-waiting-on-access",
    note: "Waiting on cluster access grant.",
    input: base({ resultJson: { summary: "Waiting on access to the staging cluster before I can continue." } }),
    expected: "blocked",
    expectedActionability: "blocked_external",
  },
  {
    id: "blocked-board-approval",
    note: "Requires board approval before a spend.",
    input: base({ resultJson: { summary: "Requires board approval before provisioning the paid tier." } }),
    expected: "blocked",
    expectedActionability: "approval_required",
  },
  {
    id: "blocked-db-password",
    note: "Blocked on a missing secret.",
    input: base({ resultJson: { summary: "Blocked on credentials: I need the database password to run the migration." } }),
    expected: "blocked",
    expectedActionability: "blocked_external",
  },
  {
    id: "blocked-pending-approval",
    note: "Pending operator approval to continue.",
    input: base({ issueCommentBodies: ["Update: pending approval from the operator before the rollout."] }),
    expected: "blocked",
    expectedActionability: "approval_required",
  },
  {
    id: "blocked-status-with-progress-text",
    note: "Blocked status plus a progress note — status still blocked.",
    input: base({ issue: { ...ISSUE, status: "blocked" }, resultJson: { summary: "Left a summary of what remains." } }),
    expected: "blocked",
  },
  {
    id: "blocked-unable-without-token",
    note: "Unable to proceed without an API token.",
    input: base({ resultJson: { summary: "I am unable to proceed without the API token for the provider." } }),
    expected: "blocked",
    expectedActionability: "blocked_external",
  },

  // --- empty_response: succeeded but produced nothing usable ----------------
  {
    id: "empty-all-null",
    note: "Succeeded with entirely empty output.",
    input: base({}),
    expected: "empty_response",
  },
  {
    id: "empty-blank-result",
    note: "Result object with no readable fields.",
    input: base({ resultJson: {} }),
    expected: "empty_response",
  },
  {
    id: "empty-only-noisy-transcript",
    note: "Only shell/tool transcript noise, all stripped.",
    input: base({ stdoutExcerpt: ["command: ls -la", "tool_call: read", "$ git status"].join("\n") }),
    expected: "empty_response",
  },
  {
    id: "empty-whitespace-summary",
    note: "Whitespace-only summary reads as empty.",
    input: base({ resultJson: { summary: "   \n  " } }),
    expected: "empty_response",
  },
  {
    id: "empty-blank-comment",
    note: "Empty comment body contributes no signal.",
    input: base({ issueCommentBodies: [""] }),
    expected: "empty_response",
  },
  {
    id: "empty-noisy-stderr",
    note: "Stderr with only a shell invocation, stripped to nothing.",
    input: base({ stderrExcerpt: "$ pnpm install" }),
    expected: "empty_response",
  },

  // --- advanced: concrete action evidence (or exempt plan/doc task) ---------
  {
    id: "advanced-issue-comment",
    note: "Posted a durable issue comment.",
    input: base({
      resultJson: { summary: "Posted a status update." },
      evidence: { issueCommentsCreated: 1, latestEvidenceAt: EVIDENCE_AT },
    }),
    expected: "advanced",
  },
  {
    id: "advanced-work-product",
    note: "Uploaded a work product artifact.",
    input: base({ evidence: { workProductsCreated: 1, latestEvidenceAt: EVIDENCE_AT } }),
    expected: "advanced",
  },
  {
    id: "advanced-doc-revisions",
    note: "Wrote two document revisions.",
    input: base({ evidence: { documentRevisionsCreated: 2, latestEvidenceAt: EVIDENCE_AT } }),
    expected: "advanced",
  },
  {
    id: "advanced-tool-and-activity",
    note: "Multiple tool/action and activity events.",
    input: base({ evidence: { toolOrActionEventsCreated: 3, activityEventsCreated: 1, latestEvidenceAt: EVIDENCE_AT } }),
    expected: "advanced",
  },
  {
    id: "advanced-activity-event",
    note: "A single durable activity event (e.g. commit-linked).",
    input: base({ evidence: { activityEventsCreated: 1, latestEvidenceAt: EVIDENCE_AT } }),
    expected: "advanced",
  },
  {
    id: "advanced-plan-task-exempt",
    note: "Planning task producing useful output is exempt from plan-only.",
    input: base({
      issue: { status: "in_progress", title: "Draft implementation plan", description: "Create a plan for the work." },
      resultJson: { summary: "Reviewed three approaches and recommended option B." },
    }),
    expected: "advanced",
  },
  {
    id: "advanced-plan-doc-revision",
    note: "Run that revised the plan document.",
    input: base({
      resultJson: { summary: "Next steps:\n- inspect files\n- implement the service" },
      evidence: { documentRevisionsCreated: 1, planDocumentRevisionsCreated: 1, latestEvidenceAt: EVIDENCE_AT },
    }),
    expected: "advanced",
  },
  {
    id: "advanced-comments-over-plan-text",
    note: "Real evidence outranks trailing plan prose.",
    input: base({
      resultJson: { summary: "Fixed the resolver. Next steps: add a regression test." },
      evidence: { issueCommentsCreated: 2, latestEvidenceAt: EVIDENCE_AT },
    }),
    expected: "advanced",
  },
  {
    id: "advanced-ran-tests",
    note: "Ran the suite and reported green, with tool evidence.",
    input: base({
      resultJson: { summary: "Ran the vitest suite, all green." },
      evidence: { toolOrActionEventsCreated: 5, latestEvidenceAt: EVIDENCE_AT },
    }),
    expected: "advanced",
  },
  {
    id: "advanced-investigation-task-exempt",
    note: "Investigation task producing findings is exempt from plan-only.",
    input: base({
      issue: { status: "in_progress", title: "Investigation: root cause of stall", description: "Investigate the stall." },
      resultJson: { summary: "Traced the stall to a missing continuation wake and documented the chain." },
    }),
    expected: "advanced",
  },

  // --- plan_only: runnable future work, no concrete evidence ----------------
  {
    id: "plan-inspect-implement",
    note: "Describes future inspect-then-implement work.",
    input: base({ resultJson: { summary: "I will inspect the repo next and then implement the fix." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-next-steps-run-tests",
    note: "Next-steps block with a runnable test command.",
    input: base({ resultJson: { summary: "Next steps: run pnpm test and report the results." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-let-me-check",
    note: "Let-me-check-and-update phrasing.",
    input: base({ resultJson: { summary: "Let me check the failing test and update the assertion." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-going-to-start",
    note: "Going-to-start-by-reading phrasing.",
    input: base({ resultJson: { summary: "I'm going to start by reading the config file." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-next-action-comment",
    note: "Durable comment naming a runnable next action.",
    input: base({ issueCommentBodies: ["Next action: run the migration script and verify row counts."] }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-plan-block",
    note: "Plan block on a non-plan task with runnable items.",
    input: base({
      issue: { status: "in_progress", title: "Implement resolver", description: "Add the resolver." },
      resultJson: { summary: "Plan:\n- inspect the schema\n- implement the resolver" },
    }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-next-begin",
    note: "Next-I-will-begin phrasing.",
    input: base({ resultJson: { summary: "Next I will begin implementing the parser." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },
  {
    id: "plan-let-me-test-update",
    note: "Let-me-test-and-update phrasing.",
    input: base({ resultJson: { summary: "Let me test the new endpoint and update the docs." } }),
    expected: "plan_only",
    expectedActionability: "runnable",
  },

  // --- needs_followup: useful output that is not safe to auto-continue ------
  {
    id: "followup-inconclusive-notes",
    note: "Mixed output left for a later pass.",
    input: base({ resultJson: { summary: "Observed mixed output and left notes for a later pass." } }),
    expected: "needs_followup",
    expectedActionability: "unknown",
  },
  {
    id: "followup-production-deploy",
    note: "Next action targets production — manager review, not auto-continue.",
    input: base({ resultJson: { summary: "Next action: deploy to production and verify live traffic." } }),
    expected: "needs_followup",
    expectedActionability: "manager_review",
  },
  {
    id: "followup-inconclusive-logs",
    note: "Reviewed logs, results inconclusive, no clear next step.",
    input: base({ resultJson: { summary: "Reviewed the logs; the results are inconclusive so far." } }),
    expected: "needs_followup",
  },
  {
    id: "followup-escalate-security",
    note: "Escalating to security for manual review.",
    input: base({ resultJson: { summary: "Escalating to the security team for manual review of the change." } }),
    expected: "needs_followup",
    expectedActionability: "manager_review",
  },
  {
    id: "followup-prod-signoff",
    note: "Recommends a production deploy sign-off.",
    input: base({ resultJson: { summary: "The change is risky; I recommend a production deploy sign-off first." } }),
    expected: "needs_followup",
    expectedActionability: "manager_review",
  },
  {
    id: "followup-cannot-determine-fix",
    note: "Summarized findings but could not determine the fix.",
    input: base({ resultJson: { summary: "Summarized the findings but could not determine the correct fix." } }),
    expected: "needs_followup",
  },
];

// ---------------------------------------------------------------------------
// Known gaming holes — pinned as expected-fail (see the .fails() block in the
// test). Each `desired` state is what a non-gameable classifier should return;
// `currentlyReturns` documents today's behavior. When the classifier is
// tightened so `desired` is produced, the pinned expected-fail test flips to
// passing and CI forces the pin to be removed — i.e. classifier changes are
// measured against these holes.
// ---------------------------------------------------------------------------
export const RUN_LIVENESS_GAMING_HOLES: RunLivenessGamingHole[] = [
  {
    id: "gaming-boilerplate-ack",
    note: "Pure wake acknowledgment with no work is treated as useful output.",
    input: base({ resultJson: { summary: "Acknowledged. I've read the wake payload and will continue on the next heartbeat." } }),
    desired: "empty_response",
    currentlyReturns: "needs_followup",
  },
  {
    id: "gaming-fake-approval-blocker",
    note: "Claimed approval blocker on a task that plainly needs none stalls for free.",
    input: base({
      issue: { status: "in_progress", title: "Add a unit test for the parser", description: "Cover the parser edge cases." },
      resultJson: { summary: "Blocked: I need board approval before I can proceed." },
    }),
    desired: "needs_followup",
    currentlyReturns: "blocked",
  },
  {
    id: "gaming-vague-clarification",
    note: "Vague 'need clarification' with no concrete question reads as a hard blocker.",
    input: base({ resultJson: { summary: "I'm unable to proceed without further clarification from the user." } }),
    desired: "needs_followup",
    currentlyReturns: "blocked",
  },
  {
    id: "gaming-contentless-next-steps",
    note: "Contentless 'Next steps' theater earns a runnable auto-continuation.",
    input: base({ resultJson: { summary: "Next steps:\n- Continue as planned\n- Proceed with the work" } }),
    desired: "needs_followup",
    currentlyReturns: "plan_only",
  },
];

// Per-state precision/recall floors. The `real` corpus is authored so the
// current classifier meets these at 1.0; the floors leave headroom for future
// label noise while staying tight enough that a single-state collapse (see the
// deliberate-loosening test) drops a floor below threshold. See the companion
// markdown for rationale.
export const PRECISION_FLOOR: Record<RunLivenessState, number> = {
  completed: 0.9,
  advanced: 0.85,
  plan_only: 0.85,
  empty_response: 0.85,
  blocked: 0.85,
  failed: 0.9,
  needs_followup: 0.8,
};

export const RECALL_FLOOR: Record<RunLivenessState, number> = {
  completed: 0.9,
  advanced: 0.85,
  plan_only: 0.85,
  empty_response: 0.85,
  blocked: 0.85,
  failed: 0.9,
  needs_followup: 0.8,
};
