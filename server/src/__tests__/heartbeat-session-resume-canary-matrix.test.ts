import { describe, expect, it } from "vitest";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import {
  buildExplicitResumeSessionOverride,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat.ts";

// POS-82 C3: Session-resume canary matrix.
//
// PF-4 (`heartbeat-timer-wake-session-reset-pf4.test.ts`) locks *when* a task
// session is reset. It never asserts that resume itself works. This matrix
// covers the other half: plant a "canary" session identity, force each
// historical session-poisoning rotation path, and assert the resume decision
// either RECALLS the exact canary or DEMONSTRABLY STARTS FRESH — never a
// poisoned hybrid (a stale pre-rotation id, or a foreign adapter's id).
//
// The unit under test is the pure resume-override decision that runs on every
// `resumeFromRunId` wake:
//   - buildExplicitResumeSessionOverride — which session to resume, or null
//   - shouldResetTaskSessionForWake     — whether a wake bypasses resume
// Both are exported and side-effect free, so the matrix is a deterministic
// table with no DB or adapter process.
//
// Rotation paths covered (the "historical poisoning paths"):
//   1. compaction rotation  — session id rotates (before != after) mid-run
//   2. model swap           — model/profile changes, session preserved
//   3. adapter swap         — agent moves to a canonical-id adapter (hermes)
//   4. timer-wake reset     — heartbeat_timer wake must not resume the canary
//   5. token overflow       — session cleared/rotated on overflow
//
// Acceptance: every rotation path is covered, and a seeded resume-poisoning
// bug (see `seededPoisoningResumeOverride`) fails the matrix.

// A minimal identity codec matching the server's default codec shape: params
// are plain `{ sessionId, ... }` objects. The adapter-swap path is driven by
// `adapterType` (hermes_local requires canonical ids), not by the codec.
const identityCodec: AdapterSessionCodec = {
  deserialize(raw) {
    return raw && typeof raw === "object" && Object.keys(raw as object).length > 0
      ? (raw as Record<string, unknown>)
      : null;
  },
  serialize(params) {
    return params && Object.keys(params).length > 0 ? params : null;
  },
  getDisplayId(params) {
    const value = params?.sessionId;
    return typeof value === "string" && value.length > 0 ? value : null;
  },
};

// A canonical hermes session id (timestamp form the adapter emits). Used both
// for the hermes positive control and to prove that the adapter-swap "fresh"
// result is caused by the swap, not by hermes never resuming anything.
const HERMES_CANARY = "20260101_120000_abcd";
// A foreign (non-hermes) session id — resuming this under hermes is poisoning.
const FOREIGN_CANARY = "claude-sess-9f3a2b1c";

type ResumeInput = Parameters<typeof buildExplicitResumeSessionOverride>[0];
type ResumeOverrideFn = (input: ResumeInput) => { sessionDisplayId: string | null; sessionParams: Record<string, unknown> | null } | null;

type Expected =
  | { outcome: "recall"; sessionId: string }
  | { outcome: "fresh" };

type Scenario = {
  path: "compaction" | "model_swap" | "adapter_swap" | "token_overflow";
  name: string;
  input: ResumeInput;
  expected: Expected;
};

// Every scenario plants the same canary (a resumable session identity) and
// then forces one rotation path. `expected` is what a correct, non-poisoning
// resume must produce.
const RESUME_SCENARIOS: Scenario[] = [
  {
    path: "compaction",
    name: "compaction rotates the session id — recall the rotated id, not the stale pre-compaction one",
    input: {
      adapterType: "claude_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "canary-pre-compaction",
      resumeRunSessionIdAfter: "canary-post-compaction",
      resumeRunSessionParams: null,
      taskSession: {
        sessionParamsJson: { sessionId: "canary-post-compaction" },
        sessionDisplayId: "canary-post-compaction",
        lastRunId: "run-1",
      },
      sessionCodec: identityCodec,
    },
    expected: { outcome: "recall", sessionId: "canary-post-compaction" },
  },
  {
    path: "model_swap",
    name: "model/profile swap preserves the session — recall the canary unchanged",
    input: {
      adapterType: "claude_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "canary-session",
      resumeRunSessionIdAfter: "canary-session",
      resumeRunSessionParams: null,
      taskSession: {
        // Carries extra accumulated context alongside the id — must survive.
        sessionParamsJson: { sessionId: "canary-session", modelProfile: "opus" },
        sessionDisplayId: "canary-session",
        lastRunId: "run-1",
      },
      sessionCodec: identityCodec,
    },
    expected: { outcome: "recall", sessionId: "canary-session" },
  },
  {
    path: "adapter_swap",
    name: "adapter swap into a canonical-id adapter drops a foreign session — start fresh, do not poison",
    input: {
      // Agent now runs on hermes_local, which only accepts canonical ids. The
      // resumed run's session id belongs to the previous (foreign) adapter.
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: FOREIGN_CANARY,
      resumeRunSessionIdAfter: FOREIGN_CANARY,
      resumeRunSessionParams: { sessionId: FOREIGN_CANARY },
      taskSession: {
        sessionParamsJson: { sessionId: FOREIGN_CANARY },
        sessionDisplayId: FOREIGN_CANARY,
        lastRunId: "run-1",
      },
      sessionCodec: identityCodec,
    },
    expected: { outcome: "fresh" },
  },
  {
    path: "adapter_swap",
    name: "canonical adapter still recalls its OWN valid session (control for the swap-drop above)",
    input: {
      adapterType: "hermes_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: HERMES_CANARY,
      resumeRunSessionIdAfter: HERMES_CANARY,
      resumeRunSessionParams: { sessionId: HERMES_CANARY },
      taskSession: {
        sessionParamsJson: { sessionId: HERMES_CANARY },
        sessionDisplayId: HERMES_CANARY,
        lastRunId: "run-1",
      },
      sessionCodec: identityCodec,
    },
    expected: { outcome: "recall", sessionId: HERMES_CANARY },
  },
  {
    path: "token_overflow",
    name: "token overflow rotates to a fresh session — recall the surviving post-overflow id, not the pre-overflow one",
    input: {
      adapterType: "claude_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "canary-pre-overflow",
      resumeRunSessionIdAfter: "canary-post-overflow",
      resumeRunSessionParams: null,
      // Overflow cleared the persisted task session; only the run's rotated id
      // survives to reconcile against.
      taskSession: null,
      sessionCodec: identityCodec,
    },
    expected: { outcome: "recall", sessionId: "canary-post-overflow" },
  },
  {
    path: "token_overflow",
    name: "token overflow clears the session entirely — start fresh, resume nothing",
    input: {
      adapterType: "claude_local",
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: null,
      resumeRunSessionIdAfter: null,
      resumeRunSessionParams: null,
      taskSession: null,
      sessionCodec: identityCodec,
    },
    expected: { outcome: "fresh" },
  },
];

// Classify a resume-override result and check it against the scenario's
// expectation. A "recall" must resume the EXACT expected id; a "fresh" must
// resume nothing. Anything else (wrong id, or resuming when it should not) is
// a poisoned resume and fails the row.
function evaluate(fn: ResumeOverrideFn, scenario: Scenario): { pass: boolean; detail: string } {
  const result = fn(scenario.input);
  if (scenario.expected.outcome === "fresh") {
    return result === null
      ? { pass: true, detail: "fresh" }
      : { pass: false, detail: `expected fresh, resumed "${result.sessionDisplayId}"` };
  }
  const want = scenario.expected.sessionId;
  if (result === null) {
    return { pass: false, detail: `expected recall of "${want}", got fresh` };
  }
  return result.sessionDisplayId === want
    ? { pass: true, detail: `recall ${want}` }
    : { pass: false, detail: `expected recall of "${want}", resumed "${result.sessionDisplayId}"` };
}

// A seeded resume-poisoning bug: always resume the resumed run's PRE-rotation
// session id, with no canonical-adapter guard. This reproduces two historical
// poisoning modes at once:
//   - resuming the stale pre-compaction / pre-overflow id after a rotation
//   - resuming a foreign adapter's id after an adapter swap
// The matrix must catch it. If it does not, the matrix is toothless.
const seededPoisoningResumeOverride: ResumeOverrideFn = (input) => {
  const displayId = input.resumeRunSessionIdBefore ?? input.resumeRunSessionIdAfter ?? null;
  if (!displayId) return null;
  return { sessionDisplayId: displayId, sessionParams: { sessionId: displayId } };
};

describe("POS-82 C3 session-resume canary matrix", () => {
  it("covers every historical rotation path", () => {
    const covered = new Set(RESUME_SCENARIOS.map((s) => s.path));
    // timer-wake reset is the fifth path, asserted separately below.
    expect(covered).toEqual(new Set(["compaction", "model_swap", "adapter_swap", "token_overflow"]));
  });

  describe("the real resume-override recalls the canary or starts fresh", () => {
    for (const scenario of RESUME_SCENARIOS) {
      it(`[${scenario.path}] ${scenario.name}`, () => {
        const { pass, detail } = evaluate(buildExplicitResumeSessionOverride, scenario);
        expect(pass, detail).toBe(true);
      });
    }
  });

  it("timer-wake (heartbeat_timer) resets instead of resuming the planted canary", () => {
    // A resumable canary exists, but a timer wake is exploratory and must not
    // resume it — it starts fresh regardless of what buildExplicitResumeSession-
    // Override would otherwise recall. Complements PF-4's "when to reset" lock
    // with the "resume is bypassed" guarantee.
    expect(shouldResetTaskSessionForWake({ wakeReason: "heartbeat_timer" })).toBe(true);
    // A resume-carrying wake (issue_commented) does NOT reset — resume applies.
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("a seeded resume-poisoning bug fails the matrix", () => {
    const failures = RESUME_SCENARIOS.filter((s) => !evaluate(seededPoisoningResumeOverride, s).pass);
    const failedPaths = new Set(failures.map((s) => s.path));

    // The matrix must have teeth: the seeded bug is caught on at least one row.
    expect(failures.length).toBeGreaterThan(0);
    // Specifically, it must catch the cross-adapter and stale-rotation poisoning
    // it introduces — the exact regressions this suite exists to prevent.
    expect(failedPaths.has("adapter_swap")).toBe(true);
    expect(failedPaths.has("compaction")).toBe(true);
    expect(failedPaths.has("token_overflow")).toBe(true);
  });
});
