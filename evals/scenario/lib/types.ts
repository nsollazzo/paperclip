// Core types for the Phase 1 scenario-eval harness.
//
// A scenario boots a real server, seeds a company/agent/issue, triggers a real
// wake, waits for the heartbeat run to reach a terminal state, then reads the
// resulting DB end-state back over the API and asserts *deterministic* hard
// checks against it. No judge model is involved in Phase 1 — every check is a
// pure function over the end-state snapshot.
//
// See doc/plans/2026-03-13-agent-evals-framework.md (Phase 1).

/**
 * A bundle is the unit of behavior under test: adapter + model + prompt/skill
 * versions + runtime flags. Phase 1 only varies adapter/model (the "cheap
 * profile"); the rest are captured for provenance and future compare runs.
 */
export interface EvalBundle {
  id: string;
  adapter: string;
  model: string;
  /** Optional runtime flags recorded for provenance. */
  flags?: Record<string, string | number | boolean>;
}

export type WakeTrigger = "assignment" | "timer" | "on_demand" | "comment";

/**
 * One issue as read back from the API after a run. Deliberately narrow: only
 * the fields the disposition-truth checks need.
 */
export interface IssueSnapshot {
  id: string;
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Issues blocking this one (resolved from blockedByIssueIds). */
  blockedBy: Array<{ id: string; identifier?: string; status?: string }>;
}

export interface CommentSnapshot {
  id: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

export interface WorkProductSnapshot {
  id: string;
  type: string;
  title?: string | null;
}

/**
 * An ordered activity/audit event for the issue. Used to prove ordering
 * invariants such as "checkout precedes mutation".
 */
export interface ActivityEventSnapshot {
  type: string;
  createdAt: string;
  actorAgentId?: string | null;
  actorUserId?: string | null;
}

export type RunStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  error: string | null;
}

/**
 * Everything a hard check may inspect. Built by lib/paperclip-client.ts from
 * live API reads, or hand-authored in unit tests (including "sabotaged"
 * variants that must make the corresponding check fail).
 *
 * `comments` and `workProducts` are **run-scoped**: only the rows this
 * heartbeat run authored (matched via `createdByRunId`). That is what lets us
 * distinguish "the agent did something fresh this wake" from pre-seeded state.
 */
export interface EndStateSnapshot {
  /** The agent under test — used to distinguish self vs non-self reviewers. */
  agentUnderTestId: string;
  /** The comment id that triggered a comment wake, if any. */
  wakeCommentId: string | null;
  /** The comment body that triggered a comment wake, if any. */
  wakeCommentBody: string | null;
  run: RunSnapshot;
  /** The primary issue for the scenario, or null (e.g. no-work timer wake). */
  issue: IssueSnapshot | null;
  /** Comments this run authored on the issue (createdByRunId === run.id). */
  comments: CommentSnapshot[];
  /** Work products this run created on the issue. */
  workProducts: WorkProductSnapshot[];
  /** Issue activity/audit events, ordered oldest-first. */
  activity: ActivityEventSnapshot[];
}

export interface CheckResult {
  id: string;
  pass: boolean;
  /** Human-readable explanation, always populated (pass or fail). */
  reason: string;
}

/** A pure, deterministic assertion over the end-state. */
export type HardCheck = (snap: EndStateSnapshot) => CheckResult;

/**
 * A scenario: how to seed, how to wake, and which hard checks must all pass.
 */
export interface ScenarioCase {
  id: string;
  description: string;
  tags: string[];
  wake: WakeTrigger;
  /** The hard checks that must all pass for this scenario to be green. */
  checks: HardCheck[];
}

export interface ScenarioResult {
  caseId: string;
  bundleId: string;
  runStatus: RunStatus;
  checks: CheckResult[];
  pass: boolean;
}
