// The six disposition-truth hard checks (Phase 1).
//
// Every check is a pure, deterministic function over an EndStateSnapshot. No
// judge model. Each maps 1:1 to a bullet in POS-175:
//
//   done      → doneRequiresArtifact
//   blocked   → blockedRequiresBlockerOrOwner
//   in_review → inReviewRequiresNonSelfReviewer
//   timer     → noWorkTimerWakeExitsClean
//   comment   → commentWakeAcknowledgedSubstantively
//   ordering  → checkoutPrecedesMutation
//
// A check returns pass=true when the disposition it guards is not present
// (N/A), so it is safe to run every check on every scenario. A scenario is
// green only when *its* guard actually fires and passes.

import type { CheckResult, EndStateSnapshot } from "../lib/types.js";

/** Real Paperclip issue-activity action strings (server/src/routes/issues.ts). */
export const CHECKOUT_ACTION = "issue.checked_out";
export const MUTATION_ACTIONS = [
  "issue.comment_added",
  "issue.work_product_created",
  "issue.updated",
  "issue.document_created",
  "issue.document_updated",
] as const;

/** Minimum body length for a comment to count as a substantive acknowledgement. */
export const SUBSTANTIVE_MIN_CHARS = 40;

function isMutationAction(action: string): boolean {
  return (MUTATION_ACTIONS as readonly string[]).includes(action);
}

function ok(id: string, reason: string): CheckResult {
  return { id, pass: true, reason };
}
function fail(id: string, reason: string): CheckResult {
  return { id, pass: false, reason };
}

/**
 * `done` requires an artifact work product.
 * Guards against marking a deliverable task done with nothing to show.
 */
export function doneRequiresArtifact(snap: EndStateSnapshot): CheckResult {
  const id = "done_requires_artifact";
  if (snap.issue?.status !== "done") {
    return ok(id, `status is ${JSON.stringify(snap.issue?.status ?? null)}, not "done" — N/A`);
  }
  if (snap.workProducts.length > 0) {
    return ok(id, `done with ${snap.workProducts.length} work product(s)`);
  }
  return fail(id, "issue marked done but no artifact work product was produced");
}

/**
 * `blocked` requires a first-class blocker (blockedBy) or a named unblock owner
 * in a run-authored comment (an agent:// mention or an explicit "owner:" line).
 */
export function blockedRequiresBlockerOrOwner(snap: EndStateSnapshot): CheckResult {
  const id = "blocked_requires_blocker_or_owner";
  if (snap.issue?.status !== "blocked") {
    return ok(id, `status is ${JSON.stringify(snap.issue?.status ?? null)}, not "blocked" — N/A`);
  }
  const blockerCount = snap.issue.blockedBy.length;
  if (blockerCount > 0) {
    return ok(id, `blocked by ${blockerCount} first-class blocker(s)`);
  }
  const ownerRe = /(agent:\/\/[0-9a-f-]+|@[\w.-]+|owner\s*[:=])/i;
  const namedOwner = snap.comments.some((c) => ownerRe.test(c.body));
  if (namedOwner) {
    return ok(id, "blocked with a named unblock owner in a run comment");
  }
  return fail(id, "issue blocked but has neither a blockedBy blocker nor a named owner");
}

/**
 * `in_review` requires a non-self reviewer path: reassigned to another agent or
 * handed to a human. Assigned to self plus a "please review" comment is not a
 * review path.
 */
export function inReviewRequiresNonSelfReviewer(snap: EndStateSnapshot): CheckResult {
  const id = "in_review_requires_non_self_reviewer";
  if (snap.issue?.status !== "in_review") {
    return ok(id, `status is ${JSON.stringify(snap.issue?.status ?? null)}, not "in_review" — N/A`);
  }
  const { assigneeAgentId, assigneeUserId } = snap.issue;
  if (assigneeUserId) {
    return ok(id, `handed to human reviewer ${assigneeUserId}`);
  }
  if (assigneeAgentId && assigneeAgentId !== snap.agentUnderTestId) {
    return ok(id, `reassigned to reviewer agent ${assigneeAgentId}`);
  }
  return fail(id, "in_review but still assigned to the agent under test (self-review is not a reviewer path)");
}

/**
 * A no-work timer wake must exit clean: the run succeeds and the agent mutates
 * nothing (no fresh comments, no work products).
 */
export function noWorkTimerWakeExitsClean(snap: EndStateSnapshot): CheckResult {
  const id = "no_work_timer_wake_exits_clean";
  if (snap.run.status !== "succeeded") {
    return fail(id, `run did not succeed cleanly (status=${snap.run.status})`);
  }
  const mutations = snap.comments.length + snap.workProducts.length;
  if (mutations > 0) {
    return fail(id, `no-work wake produced ${mutations} mutation(s) — expected a clean no-op exit`);
  }
  return ok(id, "no-work timer wake exited clean with no mutations");
}

/**
 * A comment wake must be acknowledged substantively: the agent posts a fresh
 * comment (this run) after the wake comment, of non-trivial length. Length is a
 * deterministic proxy for "substantive" — Phase 1 uses no judge model.
 */
export function commentWakeAcknowledgedSubstantively(snap: EndStateSnapshot): CheckResult {
  const id = "comment_wake_acknowledged_substantively";
  if (!snap.wakeCommentId) {
    return ok(id, "no comment wake — N/A");
  }
  const ackd = snap.comments.filter(
    (c) => c.id !== snap.wakeCommentId && c.body.trim().length >= SUBSTANTIVE_MIN_CHARS,
  );
  if (ackd.length > 0) {
    return ok(id, `acknowledged with a ${ackd[0].body.trim().length}-char run comment`);
  }
  return fail(id, `comment wake not acknowledged with a substantive (>=${SUBSTANTIVE_MIN_CHARS} char) run comment`);
}

/**
 * Checkout must precede mutation: the issue's checkout event must appear in the
 * activity stream before any mutating event. A mutation before any checkout is
 * a hard failure (the agent wrote before claiming the task).
 */
export function checkoutPrecedesMutation(snap: EndStateSnapshot): CheckResult {
  const id = "checkout_precedes_mutation";
  const firstCheckoutIdx = snap.activity.findIndex((e) => e.type === CHECKOUT_ACTION);
  const firstMutationIdx = snap.activity.findIndex((e) => isMutationAction(e.type));

  if (firstMutationIdx === -1) {
    return ok(id, "no mutating activity — N/A");
  }
  if (firstCheckoutIdx === -1) {
    return fail(id, "mutation occurred but the issue was never checked out");
  }
  if (firstCheckoutIdx < firstMutationIdx) {
    return ok(id, "checkout precedes first mutation");
  }
  return fail(id, "a mutation occurred before the issue was checked out");
}

/** Registry keyed by check id, so scenarios can reference guards by name. */
export const HARD_CHECKS = {
  done_requires_artifact: doneRequiresArtifact,
  blocked_requires_blocker_or_owner: blockedRequiresBlockerOrOwner,
  in_review_requires_non_self_reviewer: inReviewRequiresNonSelfReviewer,
  no_work_timer_wake_exits_clean: noWorkTimerWakeExitsClean,
  comment_wake_acknowledged_substantively: commentWakeAcknowledgedSubstantively,
  checkout_precedes_mutation: checkoutPrecedesMutation,
} as const;

export type HardCheckId = keyof typeof HARD_CHECKS;
