import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  heartbeatRunWatchdogDecisions,
  issueComments,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  isoWeekStart,
  metricTreeService,
  type MetricTreeWeek,
  type VerifiedCompletionRate,
  type HollowSuccessRate,
  type DispositionTheater,
  type TokensPerVerified,
  type BabysittingLoad,
  type StallHealth,
  type SessionResumeHealth,
} from "../services/metric-tree.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A fixed "now" well past the 7-day verification window of both seeded weeks so
// every done-transition has matured.
const NOW = new Date("2026-07-01T00:00:00.000Z");
const WEEK_A = isoWeekStart(new Date("2026-06-02T00:00:00.000Z"));
const WEEK_B = new Date(WEEK_A.getTime() + 7 * 24 * 60 * 60 * 1000);
const HOUR = 60 * 60 * 1000;

// Narrowing helpers — the seeded fixtures never hit the fail-loud error path.
function vcr(week: MetricTreeWeek): VerifiedCompletionRate {
  const m = week.verifiedCompletionRate;
  if ("error" in m) throw new Error(`VCR errored: ${m.error}`);
  return m;
}
function hollow(week: MetricTreeWeek): HollowSuccessRate {
  const m = week.hollowSuccessRate;
  if ("error" in m) throw new Error(`hollow errored: ${m.error}`);
  return m;
}
function theater(week: MetricTreeWeek): DispositionTheater {
  const m = week.dispositionTheater;
  if ("error" in m) throw new Error(`theater errored: ${m.error}`);
  return m;
}
function tokens(week: MetricTreeWeek): TokensPerVerified {
  const m = week.tokensPerVerified;
  if ("error" in m) throw new Error(`tokens errored: ${m.error}`);
  return m;
}
function babysitting(week: MetricTreeWeek): BabysittingLoad {
  const m = week.babysittingLoad;
  if ("error" in m) throw new Error(`babysitting errored: ${m.error}`);
  return m;
}
function stall(week: MetricTreeWeek): StallHealth {
  const m = week.stallHealth;
  if ("error" in m) throw new Error(`stall errored: ${m.error}`);
  return m;
}
function session(week: MetricTreeWeek): SessionResumeHealth {
  const m = week.sessionResumeHealth;
  if ("error" in m) throw new Error(`session errored: ${m.error}`);
  return m;
}

describeEmbeddedPostgres("metric-tree service", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof metricTreeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-metric-tree-");
    db = createDb(tempDb.connectionString);
    svc = metricTreeService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issueWorkProducts);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(heartbeatRunWatchdogDecisions);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBase() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Positronick",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  let issueSeq = 0;
  type SeedIssueOpts = {
    createdAt?: Date;
    updatedAt?: Date;
    completedAt?: Date;
    originKind?: string;
    originId?: string;
  };
  async function seedIssue(status: string, opts: SeedIssueOpts = {}): Promise<string> {
    const id = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId,
      title: `Issue ${issueSeq}`,
      status,
      priority: "medium",
      issueNumber: issueSeq,
      identifier: `T-${issueSeq}`,
      originKind: opts.originKind ?? "manual",
      originId: opts.originId,
      completedAt: opts.completedAt,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    });
    return id;
  }

  async function seedDoneTransition(issueId: string, at: Date, actorType: "agent" | "user" = "agent") {
    await db.insert(activityLog).values({
      companyId,
      actorType,
      actorId: actorType === "agent" ? agentId : "user-1",
      agentId: actorType === "agent" ? agentId : null,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", _previous: { status: "in_progress" } },
      createdAt: at,
    });
  }

  async function seedReopen(issueId: string, at: Date, actorType: "agent" | "user" = "agent") {
    await db.insert(activityLog).values({
      companyId,
      actorType,
      actorId: actorType === "agent" ? agentId : "user-1",
      agentId: actorType === "agent" ? agentId : null,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "todo", reopened: true, reopenedFrom: "done" },
      createdAt: at,
    });
  }

  async function seedWorkProduct(issueId: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR",
      status: "open",
    });
  }

  async function seedRun(
    at: Date,
    status: string,
    livenessState: string | null,
    wakeSource = "timer",
    usageJson?: Record<string, unknown>,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: wakeSource,
      status,
      livenessState,
      startedAt: at,
      finishedAt: at,
      createdAt: at,
      usageJson,
    });
    return id;
  }

  async function seedCost(issueId: string | null, at: Date, inputTokens: number) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens,
      costCents: 100,
      occurredAt: at,
    });
  }

  // Generic activity_log row (for handoff/attention actions not covered by the
  // dedicated done/reopen helpers above).
  async function seedActivity(action: string, issueId: string, at: Date, actorType: "agent" | "user" = "agent") {
    await db.insert(activityLog).values({
      companyId,
      actorType,
      actorId: actorType === "agent" ? agentId : "user-1",
      agentId: actorType === "agent" ? agentId : null,
      action,
      entityType: "issue",
      entityId: issueId,
      details: {},
      createdAt: at,
    });
  }

  async function seedComment(
    issueId: string,
    at: Date,
    body: string,
    author: "agent" | "user" = "agent",
  ) {
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: author === "agent" ? agentId : null,
      authorUserId: author === "user" ? "user-1" : null,
      authorType: author,
      body,
      createdAt: at,
    });
  }

  async function seedWatchdogDecision(runId: string, decision: string, at: Date) {
    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId,
      runId,
      decision,
      createdAt: at,
    });
  }

  async function seedApproval(type: string, status: string, at: Date) {
    await db.insert(approvals).values({
      companyId,
      type,
      status,
      payload: {},
      createdAt: at,
    });
  }

  // A thread interaction on `issueId`. Agent-created by default; pass a user
  // resolver to model a real human response.
  async function seedInteraction(
    issueId: string,
    opts: { createdBy?: "agent" | "user"; resolvedByUser?: boolean } = {},
  ) {
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: opts.resolvedByUser ? "accepted" : "pending",
      createdByAgentId: opts.createdBy === "user" ? null : agentId,
      createdByUserId: opts.createdBy === "user" ? "user-1" : null,
      resolvedByUserId: opts.resolvedByUser ? "user-1" : null,
      payload: {},
    });
  }

  // Week A: one genuinely-verified completion; healthy runs.
  async function seedWeekA() {
    const a1 = await seedIssue("done");
    await seedDoneTransition(a1, new Date(WEEK_A.getTime() + HOUR));
    await seedWorkProduct(a1);
    await seedCost(a1, new Date(WEEK_A.getTime() + HOUR), 1000);
    await seedRun(new Date(WEEK_A.getTime() + 2 * HOUR), "succeeded", "completed");
    await seedRun(new Date(WEEK_A.getTime() + 3 * HOUR), "succeeded", "advanced");
  }

  // Week B: two done-transitions, neither survives (one has no artifact, one is
  // reopened within 7d); one succeeded run is hollow. Encodes the regression.
  async function seedWeekB() {
    const b1 = await seedIssue("done"); // done but NO work product -> not verified
    await seedDoneTransition(b1, new Date(WEEK_B.getTime() + HOUR));

    const b2 = await seedIssue("todo"); // done with artifact but reopened -> theater
    await seedDoneTransition(b2, new Date(WEEK_B.getTime() + HOUR));
    await seedWorkProduct(b2);
    await seedReopen(b2, new Date(WEEK_B.getTime() + 2 * HOUR));

    await seedCost(b1, new Date(WEEK_B.getTime() + HOUR), 1000);
    await seedRun(new Date(WEEK_B.getTime() + 2 * HOUR), "succeeded", "completed");
    await seedRun(new Date(WEEK_B.getTime() + 3 * HOUR), "succeeded", "empty_response"); // hollow
  }

  it("computes VCR from activity_log with artifact + survival gates", async () => {
    await seedBase();
    await seedWeekA();
    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = vcr(week);
    expect(m.doneTransitions).toBe(1);
    expect(m.maturedTransitions).toBe(1);
    expect(m.verifiedCompletions).toBe(1);
    expect(m.rate).toBe(1);
  });

  it("a hollow-done fixture measurably moves VCR and disposition-theater", async () => {
    await seedBase();
    await seedWeekA();
    await seedWeekB();

    const weekA = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const weekB = await svc.computeWeek(companyId, { weekStart: WEEK_B, now: NOW });

    // VCR collapses: week A fully verified, week B nothing survives.
    expect(vcr(weekA).rate).toBe(1);
    expect(vcr(weekB).maturedTransitions).toBe(2);
    expect(vcr(weekB).verifiedCompletions).toBe(0);
    expect(vcr(weekB).rate).toBe(0);

    // Disposition-theater rises: the reopened-within-7d done is theater.
    expect(theater(weekA).rate).toBe(0);
    expect(theater(weekB).doneReopenWithin7d).toBe(1);
    expect(theater(weekB).rate).toBeGreaterThan(0);
  });

  it("computes hollow-success rate split by wake source", async () => {
    await seedBase();
    await seedWeekB();
    const week = await svc.computeWeek(companyId, { weekStart: WEEK_B, now: NOW });
    const m = hollow(week);
    expect(m.succeededRuns).toBe(2);
    expect(m.hollowRuns).toBe(1);
    expect(m.rate).toBe(0.5);
    expect(m.byWakeSource.find((s) => s.wakeSource === "timer")?.hollow).toBe(1);
  });

  it("reports tokens per verified completion and unattributed leakage", async () => {
    await seedBase();
    await seedWeekA();
    await seedCost(null, new Date(WEEK_A.getTime() + HOUR), 500); // unattributed leakage
    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = tokens(week);
    expect(m.totalTokens).toBe(1500);
    expect(m.unattributedTokens).toBe(500);
    expect(m.verifiedCompletions).toBe(1);
    expect(m.tokensPerVerifiedCompletion).toBe(1500);
  });

  it("fires week-over-week band-breach alerts on a seeded regression", async () => {
    await seedBase();
    await seedWeekA();
    await seedWeekB();

    // Persist week A as the stable baseline, then evaluate week B against it.
    await svc.persistWeek(await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW }));
    const { alerts } = await svc.computeWithAlerts(companyId, { weekStart: WEEK_B, now: NOW });

    const metrics = alerts.map((a) => a.metric);
    expect(metrics).toContain("hollowSuccessRate");
    expect(metrics).toContain("verifiedCompletionRate");
    expect(metrics).toContain("dispositionTheater");
    expect(alerts.find((a) => a.metric === "verifiedCompletionRate")?.direction).toBe("down");
    expect(alerts.find((a) => a.metric === "hollowSuccessRate")?.direction).toBe("up");
  });

  it("persists weekly snapshots idempotently (re-run converges, no duplicates)", async () => {
    await seedBase();
    await seedWeekA();
    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    await svc.persistWeek(week);
    await svc.persistWeek(week); // second run must not duplicate

    const stored = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "metric_tree.week_snapshot")));
    expect(stored.length).toBe(1);
    const reloaded = await svc.getPersistedWeek(companyId, WEEK_A);
    expect(reloaded?.weekStart).toBe(week.weekStart);
  });

  // ---- Metric 5: babysitting load -----------------------------------------
  it("counts babysitting-load attention signals and first-human-touch dwell", async () => {
    await seedBase();
    const anchor = new Date(WEEK_A.getTime() + HOUR);

    // Missing-disposition handoffs (2).
    const h1 = await seedIssue("in_progress");
    await seedActivity("issue.successful_run_handoff_required", h1, anchor);
    await seedActivity("issue.successful_run_handoff_escalated", h1, new Date(WEEK_A.getTime() + 2 * HOUR));

    // Continuation-exhaustion comment (1).
    const c1 = await seedIssue("in_progress");
    await seedComment(c1, anchor, "Bounded liveness continuation exhausted (attempt 3); escalating.");

    // Watchdog false-positive dismissals (2).
    const run = await seedRun(anchor, "succeeded", "completed");
    await seedWatchdogDecision(run, "dismissed_false_positive", anchor);
    await seedWatchdogDecision(run, "dismissed_false_positive", new Date(WEEK_A.getTime() + 2 * HOUR));

    // Human reopen (1).
    const r1 = await seedIssue("todo");
    await seedReopen(r1, anchor, "user");

    // Pending budget-override approval (1); a non-pending one must not count.
    await seedApproval("budget_override_required", "pending", anchor);
    await seedApproval("budget_override_required", "approved", anchor);

    // First-human-touch dwell: an in-week issue a user first touches 3h after create.
    const p = await seedIssue("in_progress", { createdAt: new Date(WEEK_A.getTime() + HOUR) });
    await seedComment(p, new Date(WEEK_A.getTime() + 4 * HOUR), "Please prioritise this.", "user");

    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = babysitting(week);
    expect(m.missingDispositionAttentions).toBe(2);
    expect(m.continuationExhaustionComments).toBe(1);
    expect(m.watchdogDismissals).toBe(2);
    expect(m.humanReopens).toBe(1);
    expect(m.pendingBudgetOverrides).toBe(1);
    expect(m.issuesCreated).toBe(1); // only `p` is created in-week
    expect(m.issuesTouchedByHuman).toBe(1);
    expect(m.avgDwellToFirstHumanTouchMs).toBe(3 * HOUR);
  });

  // ---- Metric 6: stall dwell + re-stall ------------------------------------
  it("measures stall dwell and re-stall rate across incident keys", async () => {
    await seedBase();
    const createdAt = new Date(WEEK_A.getTime() + HOUR);

    // Incident key X: first escalation resolved (3h dwell), second shares the
    // originId -> the key re-stalled.
    await seedIssue("done", {
      originKind: "harness_liveness_escalation",
      originId: "incident-x",
      createdAt,
      completedAt: new Date(WEEK_A.getTime() + 4 * HOUR),
    });
    await seedIssue("in_progress", {
      originKind: "harness_liveness_escalation",
      originId: "incident-x",
      createdAt: new Date(WEEK_A.getTime() + 5 * HOUR),
    });

    // Incident key Y: single escalation, not re-stalled.
    await seedIssue("in_progress", {
      originKind: "harness_liveness_escalation",
      originId: "incident-y",
      createdAt,
    });

    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = stall(week);
    expect(m.incidents).toBe(3);
    expect(m.resolvedIncidents).toBe(1);
    expect(m.avgStallDwellMs).toBe(3 * HOUR);
    expect(m.distinctIncidentKeys).toBe(2);
    expect(m.reStalledIncidentKeys).toBe(1);
    expect(m.reStallRate).toBe(0.5);
  });

  // ---- Metric 7: session-resume health -------------------------------------
  it("splits session-resume failure/hollow rates for reused vs fresh runs", async () => {
    await seedBase();
    const t = (h: number) => new Date(WEEK_A.getTime() + h * HOUR);

    // Reused runs (3): one failed, one hollow-succeeded, one healthy; segmented by
    // rotation reason and model via usage_json.
    await seedRun(t(1), "failed", null, "timer", {
      sessionReused: "true", sessionRotationReason: "context_limit", model: "claude-opus-4-8",
    });
    await seedRun(t(2), "succeeded", "empty_response", "timer", {
      sessionReused: "true", sessionRotationReason: "context_limit", model: "claude-opus-4-8",
    });
    await seedRun(t(3), "succeeded", "completed", "timer", {
      sessionReused: "true", model: "claude-sonnet-5",
    });

    // Fresh runs (2): one healthy, one failed. `sessionReused` false/absent -> fresh.
    await seedRun(t(4), "succeeded", "completed", "timer", { sessionReused: "false" });
    await seedRun(t(5), "failed", null, "timer", {});

    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = session(week);
    expect(m.reusedRuns).toBe(3);
    expect(m.freshRuns).toBe(2);
    expect(m.reusedFailureRate).toBeCloseTo(1 / 3);
    expect(m.freshFailureRate).toBe(0.5);
    expect(m.reusedHollowRate).toBeCloseTo(1 / 3);
    expect(m.freshHollowRate).toBe(0);
    expect(m.byRotationReason.find((r) => r.rotationReason === "context_limit")?.runs).toBe(2);
    const opus = m.byModel.find((r) => r.model === "claude-opus-4-8");
    expect(opus?.reusedRuns).toBe(2);
    expect(opus?.reusedFailed).toBe(1);
  });

  // ---- Metric 4c: disposition-theater in_review refinement -----------------
  it("tightens in_review theater to self-created interactions without a user response (4c)", async () => {
    await seedBase();
    const stale = new Date(WEEK_A.getTime() + HOUR); // well past the 48h cutoff vs NOW

    // Theater: dwelled >48h, agent-created interaction, no user response.
    const theaterIssue = await seedIssue("in_review", { updatedAt: stale });
    await seedInteraction(theaterIssue, { createdBy: "agent" });

    // Real (slow) review: agent-created interaction that a user resolved -> not theater.
    const resolved = await seedIssue("in_review", { updatedAt: stale });
    await seedInteraction(resolved, { createdBy: "agent", resolvedByUser: true });

    // Real review: agent interaction plus a user comment on the thread -> not theater.
    const commented = await seedIssue("in_review", { updatedAt: stale });
    await seedInteraction(commented, { createdBy: "agent" });
    await seedComment(commented, new Date(WEEK_A.getTime() + 2 * HOUR), "Looks good, approving.", "user");

    // Bare dwell with no interaction at all: no longer theater under 4c.
    await seedIssue("in_review", { updatedAt: stale });

    const week = await svc.computeWeek(companyId, { weekStart: WEEK_A, now: NOW });
    const m = theater(week);
    expect(m.inReviewDwellOver48h).toBe(1);
  });
});
