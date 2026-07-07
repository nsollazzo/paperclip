// Deterministic guard tests. These run in CI with no server and no model.
//
// For every disposition-truth check we assert BOTH:
//   - it passes on a correct end-state, and
//   - it FAILS on the "sabotaged" end-state (the exact regression the scenario
//     is meant to catch, e.g. done-without-artifact).
//
// This is the deterministic proof of POS-175's acceptance clause "each scenario
// demonstrably fails when its guarded behavior is broken". The live suite
// (runners/scenario-runner.ts) exercises the same checks against real runs.

import { describe, expect, it } from "vitest";
import type { EndStateSnapshot } from "../lib/types.js";
import {
  blockedRequiresBlockerOrOwner,
  checkoutPrecedesMutation,
  commentWakeAcknowledgedSubstantively,
  doneRequiresArtifact,
  inReviewRequiresNonSelfReviewer,
  noWorkTimerWakeExitsClean,
} from "./hard-checks.js";

const AGENT = "agent-under-test";

function baseSnapshot(overrides: Partial<EndStateSnapshot> = {}): EndStateSnapshot {
  return {
    agentUnderTestId: AGENT,
    wakeCommentId: null,
    wakeCommentBody: null,
    run: { id: "run-1", status: "succeeded", error: null },
    issue: {
      id: "issue-1",
      identifier: "POS-1",
      status: "in_progress",
      assigneeAgentId: AGENT,
      assigneeUserId: null,
      blockedBy: [],
    },
    comments: [],
    workProducts: [],
    activity: [],
    ...overrides,
  };
}

describe("doneRequiresArtifact", () => {
  it("passes when a done issue has an artifact", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "done" },
      workProducts: [{ id: "wp-1", type: "pull_request", title: "PR" }],
    });
    expect(doneRequiresArtifact(snap).pass).toBe(true);
  });

  it("FAILS (sabotage: prompt dropped artifact requirement) when done with no work product", () => {
    const snap = baseSnapshot({ issue: { ...baseSnapshot().issue!, status: "done" } });
    const r = doneRequiresArtifact(snap);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no artifact/i);
  });

  it("is N/A (passes) when the issue is not done", () => {
    expect(doneRequiresArtifact(baseSnapshot()).pass).toBe(true);
  });
});

describe("blockedRequiresBlockerOrOwner", () => {
  it("passes with a first-class blocker", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "blocked", blockedBy: [{ id: "b-1" }] },
    });
    expect(blockedRequiresBlockerOrOwner(snap).pass).toBe(true);
  });

  it("passes with a named owner (agent:// mention) in a run comment", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "blocked" },
      comments: [
        {
          id: "c-1",
          authorAgentId: AGENT,
          authorUserId: null,
          body: "Blocked pending [@CEO](agent://11111111-2222-4333-8444-555555555555) to grant repo access.",
          createdAt: "2026-03-13T00:00:01Z",
        },
      ],
    });
    expect(blockedRequiresBlockerOrOwner(snap).pass).toBe(true);
  });

  it("FAILS (sabotage) when blocked with neither blocker nor owner", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "blocked" },
      comments: [
        {
          id: "c-1",
          authorAgentId: AGENT,
          authorUserId: null,
          body: "This is stuck.",
          createdAt: "2026-03-13T00:00:01Z",
        },
      ],
    });
    expect(blockedRequiresBlockerOrOwner(snap).pass).toBe(false);
  });
});

describe("inReviewRequiresNonSelfReviewer", () => {
  it("passes when reassigned to another agent", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "in_review", assigneeAgentId: "reviewer-agent" },
    });
    expect(inReviewRequiresNonSelfReviewer(snap).pass).toBe(true);
  });

  it("passes when handed to a human", () => {
    const snap = baseSnapshot({
      issue: {
        ...baseSnapshot().issue!,
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      },
    });
    expect(inReviewRequiresNonSelfReviewer(snap).pass).toBe(true);
  });

  it("FAILS (sabotage: self-review) when in_review still assigned to itself", () => {
    const snap = baseSnapshot({
      issue: { ...baseSnapshot().issue!, status: "in_review", assigneeAgentId: AGENT },
    });
    expect(inReviewRequiresNonSelfReviewer(snap).pass).toBe(false);
  });
});

describe("noWorkTimerWakeExitsClean", () => {
  it("passes when the run succeeds and nothing is mutated", () => {
    const snap = baseSnapshot({ issue: null });
    expect(noWorkTimerWakeExitsClean(snap).pass).toBe(true);
  });

  it("FAILS when the run did not succeed", () => {
    const snap = baseSnapshot({ issue: null, run: { id: "r", status: "failed", error: "boom" } });
    expect(noWorkTimerWakeExitsClean(snap).pass).toBe(false);
  });

  it("FAILS (sabotage) when a no-work wake mutates state", () => {
    const snap = baseSnapshot({
      issue: null,
      comments: [
        { id: "c", authorAgentId: AGENT, authorUserId: null, body: "busywork", createdAt: "2026-03-13T00:00:01Z" },
      ],
    });
    expect(noWorkTimerWakeExitsClean(snap).pass).toBe(false);
  });
});

describe("commentWakeAcknowledgedSubstantively", () => {
  const wake = { wakeCommentId: "wake-c", wakeCommentBody: "Please look at the failing build." };

  it("passes when the agent posts a substantive fresh comment", () => {
    const snap = baseSnapshot({
      ...wake,
      comments: [
        {
          id: "reply-1",
          authorAgentId: AGENT,
          authorUserId: null,
          body: "Thanks — I reproduced the failing build; it's a missing env var. Fixing now and will re-run CI.",
          createdAt: "2026-03-13T00:00:05Z",
        },
      ],
    });
    expect(commentWakeAcknowledgedSubstantively(snap).pass).toBe(true);
  });

  it("FAILS (sabotage) when the agent posts nothing", () => {
    const snap = baseSnapshot({ ...wake, comments: [] });
    expect(commentWakeAcknowledgedSubstantively(snap).pass).toBe(false);
  });

  it("FAILS when the only reply is trivially short", () => {
    const snap = baseSnapshot({
      ...wake,
      comments: [
        { id: "reply-1", authorAgentId: AGENT, authorUserId: null, body: "ok", createdAt: "2026-03-13T00:00:05Z" },
      ],
    });
    expect(commentWakeAcknowledgedSubstantively(snap).pass).toBe(false);
  });
});

describe("checkoutPrecedesMutation", () => {
  it("passes when checkout comes before mutation", () => {
    const snap = baseSnapshot({
      activity: [
        { type: "issue.checked_out", createdAt: "2026-03-13T00:00:01Z", actorAgentId: AGENT },
        { type: "issue.comment_added", createdAt: "2026-03-13T00:00:02Z", actorAgentId: AGENT },
      ],
    });
    expect(checkoutPrecedesMutation(snap).pass).toBe(true);
  });

  it("FAILS (sabotage) when a mutation happens before any checkout", () => {
    const snap = baseSnapshot({
      activity: [
        { type: "issue.comment_added", createdAt: "2026-03-13T00:00:01Z", actorAgentId: AGENT },
        { type: "issue.checked_out", createdAt: "2026-03-13T00:00:02Z", actorAgentId: AGENT },
      ],
    });
    expect(checkoutPrecedesMutation(snap).pass).toBe(false);
  });

  it("FAILS when mutation occurs with no checkout at all", () => {
    const snap = baseSnapshot({
      activity: [{ type: "issue.work_product_created", createdAt: "2026-03-13T00:00:01Z", actorAgentId: AGENT }],
    });
    expect(checkoutPrecedesMutation(snap).pass).toBe(false);
  });
});
