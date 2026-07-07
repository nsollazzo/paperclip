import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
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
  async function seedIssue(status: string): Promise<string> {
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

  async function seedRun(at: Date, status: string, livenessState: string | null, wakeSource = "timer") {
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: wakeSource,
      status,
      livenessState,
      startedAt: at,
      finishedAt: at,
      createdAt: at,
    });
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
});
