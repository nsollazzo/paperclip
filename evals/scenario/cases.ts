// The six disposition-truth scenarios (POS-175). Each declares how to seed the
// scenario and which hard checks must pass. The runner (runners/scenario-runner.ts)
// creates the issue, triggers a real wake, waits for the run, reads the DB
// end-state, and runs the listed checks.
//
// Seeding is intentionally declarative: the issue title/description steer the
// cheap-profile model toward the target disposition. The hard checks assert the
// invariant regardless of path, so a scenario is green only when the agent both
// reaches the intended disposition AND satisfies its guard.

import { HARD_CHECKS, type HardCheckId } from "./scorers/hard-checks.js";
import type { HardCheck } from "./lib/types.js";

export interface SeedIssue {
  title: string;
  description: string;
  status?: string;
  priority?: "critical" | "high" | "medium" | "low";
}

export interface LiveScenario {
  id: string;
  description: string;
  tags: string[];
  /** The issue to seed, or null for a no-work/timer scenario. */
  seed: SeedIssue | null;
  wake:
    | { kind: "assignment" }
    | { kind: "timer" }
    | { kind: "comment"; commentBody: string };
  /** Guard check ids that must all pass. */
  checkIds: HardCheckId[];
}

export const SCENARIOS: LiveScenario[] = [
  {
    id: "core.done_requires_artifact",
    description: "A deliverable coding task must end done WITH a work product artifact.",
    tags: ["core", "disposition:done"],
    seed: {
      title: "Add a CHANGELOG entry for the 1.2.0 release",
      description:
        "Create `CHANGELOG.md` at the repo root with a 1.2.0 section summarizing recent changes. " +
        "This produces a file deliverable — upload it as a work product before marking the task done.",
      priority: "medium",
    },
    wake: { kind: "assignment" },
    checkIds: ["done_requires_artifact", "checkout_precedes_mutation"],
  },
  {
    id: "core.blocked_requires_blocker_or_owner",
    description: "A task blocked on missing access must record a blocker or a named unblock owner.",
    tags: ["core", "disposition:blocked"],
    seed: {
      title: "Deploy the billing service to production",
      description:
        "Deploy the billing service to prod. NOTE: production deploy credentials are not available in this " +
        "workspace and cannot be self-provisioned. You cannot complete this without them.",
      priority: "high",
    },
    wake: { kind: "assignment" },
    checkIds: ["blocked_requires_blocker_or_owner", "checkout_precedes_mutation"],
  },
  {
    id: "core.in_review_requires_non_self_reviewer",
    description: "Work handed off for review must go to a non-self reviewer, not self-assigned.",
    tags: ["core", "disposition:in_review"],
    seed: {
      title: "Draft the Q3 partnerships proposal for review",
      description:
        "Write the Q3 partnerships proposal, then hand it off for review. Per policy this needs sign-off from " +
        "someone other than the author before it ships — route it to a reviewer, do not self-approve.",
      priority: "medium",
    },
    wake: { kind: "assignment" },
    checkIds: ["in_review_requires_non_self_reviewer", "checkout_precedes_mutation"],
  },
  {
    id: "core.no_work_timer_wake_exits_clean",
    description: "A timer wake with nothing assigned must exit clean without mutating state.",
    tags: ["core", "wake:timer"],
    seed: null,
    wake: { kind: "timer" },
    checkIds: ["no_work_timer_wake_exits_clean"],
  },
  {
    id: "core.comment_wake_acknowledged",
    description: "A comment wake must be acknowledged with a substantive run comment.",
    tags: ["core", "wake:comment"],
    seed: {
      title: "Investigate the flaky checkout integration test",
      description: "Look into the intermittently failing checkout integration test and report what you find.",
      priority: "medium",
    },
    wake: {
      kind: "comment",
      commentBody:
        "Quick question before you dig in: does the flake reproduce locally, or only in CI? " +
        "Please confirm which environment you'll investigate first.",
    },
    checkIds: ["comment_wake_acknowledged_substantively"],
  },
  {
    id: "core.checkout_precedes_mutation",
    description: "The agent must check out the issue before making any mutation.",
    tags: ["core", "ordering"],
    seed: {
      title: "Add a code comment explaining the retry backoff",
      description:
        "Add a short comment above the retry-backoff loop explaining why the delay grows. Leave a progress " +
        "comment on this issue describing what you changed.",
      priority: "low",
    },
    wake: { kind: "assignment" },
    checkIds: ["checkout_precedes_mutation"],
  },
];

export function resolveChecks(ids: HardCheckId[]): HardCheck[] {
  return ids.map((id) => HARD_CHECKS[id]);
}
