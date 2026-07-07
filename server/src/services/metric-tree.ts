import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Nightly metric-tree job (POS-168, parent POS-82).
 *
 * North star: **Verified Autonomous Throughput (VAT)** — agent-closed issues/week
 * that survive verification, normalized per token and per human intervention.
 *
 * This service computes seven per-company/week companion metrics purely from
 * existing tables (`issues`, `activity_log`, `heartbeat_runs`, `issue_work_products`,
 * `cost_events`, `issue_relations`, `issue_comments`, `heartbeat_run_watchdog_decisions`,
 * `approvals`). No schema changes for the inputs. Weekly aggregates are persisted as a
 * JSON snapshot in `activity_log` (append-only, the sanctioned "JSON artifact" option),
 * exposed via one API endpoint, and week-over-week band breaches raise alerts.
 *
 * Every metric is computed independently and, on failure, records an `error` string in
 * its own slot rather than failing the whole tree (Rule 13 fail-loud: the error is
 * surfaced and logged, never silently swallowed).
 */

export const METRIC_TREE_SNAPSHOT_ACTION = "metric_tree.week_snapshot";
export const METRIC_TREE_VERIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const METRIC_TREE_IN_REVIEW_DWELL_MS = 48 * 60 * 60 * 1000;

// Terminal statuses considered by liveness; only `succeeded` is a healthy terminal.
const HOLLOW_LIVENESS_STATES = ["empty_response", "plan_only"] as const;
// Escalation activity actions that void a "verified" completion within the window.
const ESCALATION_ACTIONS = [
  "issue.harness_liveness_escalation_created",
  "issue.monitor_escalated_to_board",
  "heartbeat.output_stale_escalated",
  "issue.successful_run_handoff_escalated",
] as const;
const MISSING_DISPOSITION_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_escalated",
] as const;

// Default week-over-week alert bands. Breaching any of these raises an alert.
export const DEFAULT_METRIC_TREE_ALERT_BANDS = {
  hollowSuccessRatePointsUp: 0.05, // hollow-success rate +5pts
  vcrPointsDown: 0.1, // VCR -10pts
  dispositionTheaterRatePointsUp: 0.05, // disposition-theater +5pts
  tokensPerVerifiedFractionUp: 0.5, // tokens/verified +50%
} as const;

export type MetricTreeAlertBands = typeof DEFAULT_METRIC_TREE_ALERT_BANDS;

type MetricError = { error: string };
function isError<T>(value: T | MetricError): value is MetricError {
  return typeof value === "object" && value !== null && "error" in value;
}

function toNum(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const maybe = (result as { rows?: unknown })?.rows;
  return Array.isArray(maybe) ? (maybe as Array<Record<string, unknown>>) : [];
}

/** UTC Monday 00:00 for the ISO week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  date.setUTCDate(date.getUTCDate() - diff);
  return date;
}

// ---- Metric result shapes -------------------------------------------------

export type VerifiedCompletionRate = {
  doneTransitions: number; // all agent done-transitions in week (activity_log)
  maturedTransitions: number; // matured (>=7d elapsed) — the fair denominator
  verifiedCompletions: number; // matured AND survived AND >=1 non-plan artifact
  rate: number | null; // verified / matured
};

export type TokensPerVerified = {
  totalTokens: number;
  unattributedTokens: number; // cost_events.issueId IS NULL leakage
  unattributedFraction: number | null;
  verifiedCompletions: number;
  tokensPerVerifiedCompletion: number | null;
};

export type HollowSuccessRate = {
  succeededRuns: number;
  hollowRuns: number;
  rate: number | null;
  byWakeSource: Array<{ wakeSource: string; succeeded: number; hollow: number; rate: number | null }>;
};

export type DispositionTheater = {
  doneReopenWithin7d: number;
  blockedWithoutBlockerLink: number;
  inReviewDwellOver48h: number;
  dispositionIssues: number; // distinct issues that reached a disposition in week
  theaterIssues: number;
  rate: number | null;
};

export type BabysittingLoad = {
  missingDispositionAttentions: number;
  continuationExhaustionComments: number;
  watchdogDismissals: number;
  humanReopens: number;
  pendingBudgetOverrides: number;
  issuesCreated: number;
  issuesTouchedByHuman: number;
  avgDwellToFirstHumanTouchMs: number | null;
};

export type StallHealth = {
  incidents: number; // stall/liveness escalation issues created in week
  resolvedIncidents: number;
  avgStallDwellMs: number | null;
  distinctIncidentKeys: number;
  reStalledIncidentKeys: number; // incidentKeys with >1 escalation issue (all-time)
  reStallRate: number | null;
};

export type SessionResumeHealth = {
  reusedRuns: number;
  freshRuns: number;
  reusedFailureRate: number | null;
  freshFailureRate: number | null;
  reusedHollowRate: number | null;
  freshHollowRate: number | null;
  byRotationReason: Array<{ rotationReason: string; runs: number; failed: number; hollow: number }>;
  byModel: Array<{ model: string; reusedRuns: number; reusedFailed: number }>;
};

export type MetricTreeWeek = {
  companyId: string;
  weekStart: string; // ISO
  weekEnd: string; // ISO
  generatedAt: string; // ISO
  verifiedCompletionRate: VerifiedCompletionRate | MetricError;
  tokensPerVerified: TokensPerVerified | MetricError;
  hollowSuccessRate: HollowSuccessRate | MetricError;
  dispositionTheater: DispositionTheater | MetricError;
  babysittingLoad: BabysittingLoad | MetricError;
  stallHealth: StallHealth | MetricError;
  sessionResumeHealth: SessionResumeHealth | MetricError;
};

export type MetricTreeAlert = {
  metric: string;
  direction: "up" | "down";
  previous: number | null;
  current: number | null;
  delta: number | null;
  threshold: number;
  message: string;
};

export type MetricTreeWithAlerts = {
  current: MetricTreeWeek;
  previous: MetricTreeWeek | null;
  alerts: MetricTreeAlert[];
};

export function metricTreeService(db: Db) {
  async function runMetric<T>(name: string, fn: () => Promise<T>): Promise<T | MetricError> {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ err, metric: name }, "metric-tree metric computation failed");
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 1. Verified Completion Rate. Denominator from activity_log so reopens don't
  //    erase history; numerator survives 7d with >=1 non-plan artifact (work product)
  //    and no reopen/escalation in the window.
  async function verifiedCompletionRate(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
    now: Date,
  ): Promise<VerifiedCompletionRate> {
    const result = await db.execute(sql`
      WITH done_transitions AS (
        SELECT al.entity_id AS issue_id, al.created_at AS done_at
        FROM activity_log al
        WHERE al.company_id = ${companyId}
          AND al.entity_type = 'issue'
          AND al.action = 'issue.updated'
          AND al.actor_type = 'agent'
          AND al.details->>'status' = 'done'
          AND al.created_at >= ${weekStart.toISOString()}::timestamptz AND al.created_at < ${weekEnd.toISOString()}::timestamptz
      ),
      matured AS (
        SELECT * FROM done_transitions
        WHERE done_at + interval '7 days' <= ${now.toISOString()}::timestamptz
      ),
      verified AS (
        SELECT m.issue_id FROM matured m
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_log r
          WHERE r.company_id = ${companyId} AND r.entity_type = 'issue' AND r.entity_id = m.issue_id
            AND r.created_at > m.done_at AND r.created_at <= m.done_at + interval '7 days'
            AND ((r.details->>'reopened') = 'true' OR r.action IN ${[...ESCALATION_ACTIONS]})
        )
        AND EXISTS (
          SELECT 1 FROM issue_work_products wp
          WHERE wp.company_id = ${companyId} AND wp.issue_id = m.issue_id::uuid
        )
      )
      SELECT
        (SELECT count(*) FROM done_transitions) AS done_transitions,
        (SELECT count(*) FROM matured) AS matured,
        (SELECT count(*) FROM verified) AS verified
    `);
    const row = rows(result)[0] ?? {};
    const doneTransitions = toNum(row.done_transitions);
    const maturedTransitions = toNum(row.matured);
    const verifiedCompletions = toNum(row.verified);
    return {
      doneTransitions,
      maturedTransitions,
      verifiedCompletions,
      rate: maturedTransitions > 0 ? verifiedCompletions / maturedTransitions : null,
    };
  }

  // 2. Tokens per verified completion (tokens, not cents). Unattributed issueId=null
  //    leakage reported as its own line.
  async function tokensPerVerified(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
    verifiedCompletions: number,
  ): Promise<TokensPerVerified> {
    const result = await db.execute(sql`
      SELECT
        coalesce(sum(input_tokens + cached_input_tokens + output_tokens), 0) AS total_tokens,
        coalesce(sum(input_tokens + cached_input_tokens + output_tokens)
                 FILTER (WHERE issue_id IS NULL), 0) AS unattributed_tokens
      FROM cost_events
      WHERE company_id = ${companyId}
        AND occurred_at >= ${weekStart.toISOString()}::timestamptz AND occurred_at < ${weekEnd.toISOString()}::timestamptz
    `);
    const row = rows(result)[0] ?? {};
    const totalTokens = toNum(row.total_tokens);
    const unattributedTokens = toNum(row.unattributed_tokens);
    return {
      totalTokens,
      unattributedTokens,
      unattributedFraction: totalTokens > 0 ? unattributedTokens / totalTokens : null,
      verifiedCompletions,
      tokensPerVerifiedCompletion: verifiedCompletions > 0 ? totalTokens / verifiedCompletions : null,
    };
  }

  // 3. Hollow-success rate: succeeded runs classified empty_response/plan_only
  //    (the liveness classifier assigns these when a succeeded run has zero
  //    concrete-action evidence), split by wake source.
  async function hollowSuccessRate(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<HollowSuccessRate> {
    const result = await db.execute(sql`
      SELECT
        coalesce(invocation_source, 'unknown') AS wake_source,
        count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
        count(*) FILTER (WHERE status = 'succeeded' AND liveness_state IN ${[...HOLLOW_LIVENESS_STATES]}) AS hollow
      FROM heartbeat_runs
      WHERE company_id = ${companyId}
        AND coalesce(finished_at, started_at, created_at) >= ${weekStart.toISOString()}::timestamptz
        AND coalesce(finished_at, started_at, created_at) < ${weekEnd.toISOString()}::timestamptz
      GROUP BY 1
    `);
    let succeededRuns = 0;
    let hollowRuns = 0;
    const byWakeSource = rows(result).map((row) => {
      const succeeded = toNum(row.succeeded);
      const hollow = toNum(row.hollow);
      succeededRuns += succeeded;
      hollowRuns += hollow;
      return {
        wakeSource: String(row.wake_source ?? "unknown"),
        succeeded,
        hollow,
        rate: succeeded > 0 ? hollow / succeeded : null,
      };
    });
    return {
      succeededRuns,
      hollowRuns,
      rate: succeededRuns > 0 ? hollowRuns / succeededRuns : null,
      byWakeSource,
    };
  }

  // 4. Disposition-theater rate: done->reopen <=7d; blocked with no blocker link;
  //    in_review dwell >48h. Rate over issues that reached any disposition in week.
  //    (4c) The in_review signal is tightened to *self-created-interaction-only*
  //    review paths: an issue counts only when it has dwelled >48h AND its review is
  //    backed solely by an agent-created thread interaction that no user has responded
  //    to (no user-resolved/created interaction, no user comment). Raw dwell alone —
  //    e.g. a genuine human review that is simply slow — is not theater.
  async function dispositionTheater(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
    now: Date,
  ): Promise<DispositionTheater> {
    const result = await db.execute(sql`
      WITH done_transitions AS (
        SELECT al.entity_id AS issue_id, al.created_at AS done_at
        FROM activity_log al
        WHERE al.company_id = ${companyId} AND al.entity_type = 'issue'
          AND al.action = 'issue.updated' AND al.actor_type = 'agent'
          AND al.details->>'status' = 'done'
          AND al.created_at >= ${weekStart.toISOString()}::timestamptz AND al.created_at < ${weekEnd.toISOString()}::timestamptz
      ),
      done_reopen AS (
        SELECT DISTINCT dt.issue_id FROM done_transitions dt
        WHERE EXISTS (
          SELECT 1 FROM activity_log r
          WHERE r.company_id = ${companyId} AND r.entity_type = 'issue' AND r.entity_id = dt.issue_id
            AND r.created_at > dt.done_at AND r.created_at <= dt.done_at + interval '7 days'
            AND (r.details->>'reopened') = 'true'
        )
      ),
      blocked_no_link AS (
        SELECT i.id FROM issues i
        WHERE i.company_id = ${companyId} AND i.status = 'blocked'
          AND i.updated_at >= ${weekStart.toISOString()}::timestamptz AND i.updated_at < ${weekEnd.toISOString()}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM issue_relations rel
            WHERE rel.company_id = ${companyId} AND rel.related_issue_id = i.id AND rel.type = 'blocks'
          )
      ),
      in_review_dwell AS (
        SELECT i.id FROM issues i
        WHERE i.company_id = ${companyId} AND i.status = 'in_review'
          AND i.updated_at <= ${new Date(now.getTime() - METRIC_TREE_IN_REVIEW_DWELL_MS).toISOString()}::timestamptz
          -- 4c: only self-created-interaction-only review paths count as theater.
          AND EXISTS (
            SELECT 1 FROM issue_thread_interactions it
            WHERE it.company_id = ${companyId} AND it.issue_id = i.id
              AND it.created_by_agent_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM issue_thread_interactions itu
            WHERE itu.company_id = ${companyId} AND itu.issue_id = i.id
              AND (itu.resolved_by_user_id IS NOT NULL OR itu.created_by_user_id IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM issue_comments ic
            WHERE ic.company_id = ${companyId} AND ic.issue_id = i.id
              AND ic.author_user_id IS NOT NULL
          )
      ),
      dispositions AS (
        SELECT DISTINCT al.entity_id AS issue_id FROM activity_log al
        WHERE al.company_id = ${companyId} AND al.entity_type = 'issue'
          AND al.action = 'issue.updated'
          AND al.details->>'status' IN ('done', 'blocked', 'in_review', 'cancelled')
          AND al.created_at >= ${weekStart.toISOString()}::timestamptz AND al.created_at < ${weekEnd.toISOString()}::timestamptz
      ),
      theater AS (
        SELECT issue_id::text AS id FROM done_reopen
        UNION SELECT id::text FROM blocked_no_link
        UNION SELECT id::text FROM in_review_dwell
      )
      SELECT
        (SELECT count(*) FROM done_reopen) AS done_reopen,
        (SELECT count(*) FROM blocked_no_link) AS blocked_no_link,
        (SELECT count(*) FROM in_review_dwell) AS in_review_dwell,
        (SELECT count(*) FROM dispositions) AS dispositions,
        (SELECT count(*) FROM theater) AS theater
    `);
    const row = rows(result)[0] ?? {};
    const dispositionIssues = toNum(row.dispositions);
    const theaterIssues = toNum(row.theater);
    return {
      doneReopenWithin7d: toNum(row.done_reopen),
      blockedWithoutBlockerLink: toNum(row.blocked_no_link),
      inReviewDwellOver48h: toNum(row.in_review_dwell),
      dispositionIssues,
      theaterIssues,
      rate: dispositionIssues > 0 ? theaterIssues / dispositionIssues : null,
    };
  }

  // 5. Babysitting load: attention/intervention signals + dwell to first human touch.
  async function babysittingLoad(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<BabysittingLoad> {
    const ws = weekStart.toISOString();
    const we = weekEnd.toISOString();
    const result = await db.execute(sql`
      WITH created AS (
        SELECT id, created_at FROM issues
        WHERE company_id = ${companyId} AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz
      ),
      first_touch AS (
        SELECT c.id, c.created_at, LEAST(
          (SELECT min(ic.created_at) FROM issue_comments ic
             WHERE ic.company_id = ${companyId} AND ic.issue_id = c.id AND ic.author_user_id IS NOT NULL),
          (SELECT min(al.created_at) FROM activity_log al
             WHERE al.company_id = ${companyId} AND al.entity_type = 'issue'
               AND al.entity_id = c.id::text AND al.actor_type = 'user')
        ) AS touched_at
        FROM created c
      )
      SELECT
        (SELECT count(*) FROM activity_log
           WHERE company_id = ${companyId} AND action IN ${[...MISSING_DISPOSITION_ACTIONS]}
             AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz) AS missing_disposition,
        (SELECT count(*) FROM issue_comments
           WHERE company_id = ${companyId} AND body LIKE 'Bounded liveness continuation exhausted%'
             AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz) AS continuation_exhaustion,
        (SELECT count(*) FROM heartbeat_run_watchdog_decisions
           WHERE company_id = ${companyId} AND decision = 'dismissed_false_positive'
             AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz) AS watchdog_dismissals,
        (SELECT count(*) FROM activity_log
           WHERE company_id = ${companyId} AND actor_type = 'user'
             AND (details->>'reopened') = 'true'
             AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz) AS human_reopens,
        (SELECT count(*) FROM approvals
           WHERE company_id = ${companyId} AND type = 'budget_override_required' AND status = 'pending'
             AND created_at >= ${ws}::timestamptz AND created_at < ${we}::timestamptz) AS pending_budget_overrides,
        (SELECT count(*) FROM created) AS issues_created,
        (SELECT count(*) FROM first_touch WHERE touched_at IS NOT NULL) AS touched_count,
        (SELECT avg(EXTRACT(EPOCH FROM (touched_at - created_at)) * 1000)
           FROM first_touch WHERE touched_at IS NOT NULL) AS avg_dwell_ms
    `);
    const row = rows(result)[0] ?? {};
    const avg = row.avg_dwell_ms;
    return {
      missingDispositionAttentions: toNum(row.missing_disposition),
      continuationExhaustionComments: toNum(row.continuation_exhaustion),
      watchdogDismissals: toNum(row.watchdog_dismissals),
      humanReopens: toNum(row.human_reopens),
      pendingBudgetOverrides: toNum(row.pending_budget_overrides),
      issuesCreated: toNum(row.issues_created),
      issuesTouchedByHuman: toNum(row.touched_count),
      avgDwellToFirstHumanTouchMs: avg == null ? null : toNum(avg),
    };
  }

  // 6. Stall dwell + re-stall per incidentKey. incidentKey = issues.originId with
  //    originKind='harness_liveness_escalation'; a stall incident is one such issue.
  async function stallHealth(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<StallHealth> {
    const result = await db.execute(sql`
      WITH incidents AS (
        SELECT id, origin_id, status, created_at, completed_at, updated_at
        FROM issues
        WHERE company_id = ${companyId} AND origin_kind = 'harness_liveness_escalation'
          AND created_at >= ${weekStart.toISOString()}::timestamptz AND created_at < ${weekEnd.toISOString()}::timestamptz
      ),
      key_counts AS (
        SELECT origin_id, count(*) AS n FROM issues
        WHERE company_id = ${companyId} AND origin_kind = 'harness_liveness_escalation'
        GROUP BY origin_id
      )
      SELECT
        (SELECT count(*) FROM incidents) AS incidents,
        (SELECT count(*) FROM incidents WHERE status IN ('done', 'cancelled')) AS resolved,
        (SELECT avg(EXTRACT(EPOCH FROM (coalesce(completed_at, updated_at) - created_at)) * 1000)
           FROM incidents WHERE status IN ('done', 'cancelled')) AS avg_dwell_ms,
        (SELECT count(*) FROM key_counts) AS distinct_keys,
        (SELECT count(*) FROM key_counts WHERE n > 1) AS restalled_keys
    `);
    const row = rows(result)[0] ?? {};
    const distinctIncidentKeys = toNum(row.distinct_keys);
    const avg = row.avg_dwell_ms;
    return {
      incidents: toNum(row.incidents),
      resolvedIncidents: toNum(row.resolved),
      avgStallDwellMs: avg == null ? null : toNum(avg),
      distinctIncidentKeys,
      reStalledIncidentKeys: toNum(row.restalled_keys),
      reStallRate: distinctIncidentKeys > 0 ? toNum(row.restalled_keys) / distinctIncidentKeys : null,
    };
  }

  // 7. Session-resume health: failure/hollow rate of reused-session runs vs fresh,
  //    segmented by rotation reason and model (from usage_json).
  async function sessionResumeHealth(
    companyId: string,
    weekStart: Date,
    weekEnd: Date,
  ): Promise<SessionResumeHealth> {
    const ws = weekStart.toISOString();
    const we = weekEnd.toISOString();
    const inWindow = sql`
      hr.company_id = ${companyId}
        AND hr.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
        AND coalesce(hr.finished_at, hr.started_at, hr.created_at) >= ${ws}::timestamptz
        AND coalesce(hr.finished_at, hr.started_at, hr.created_at) < ${we}::timestamptz
    `;
    const totals = await db.execute(sql`
      SELECT
        (hr.usage_json->>'sessionReused') = 'true' AS reused,
        count(*) AS runs,
        count(*) FILTER (WHERE hr.status <> 'succeeded') AS failed,
        count(*) FILTER (WHERE hr.liveness_state IN ${[...HOLLOW_LIVENESS_STATES]}) AS hollow
      FROM heartbeat_runs hr
      WHERE ${inWindow}
      GROUP BY 1
    `);
    let reusedRuns = 0, reusedFailed = 0, reusedHollow = 0;
    let freshRuns = 0, freshFailed = 0, freshHollow = 0;
    for (const row of rows(totals)) {
      const runs = toNum(row.runs), failed = toNum(row.failed), hollow = toNum(row.hollow);
      if (row.reused === true) {
        reusedRuns += runs; reusedFailed += failed; reusedHollow += hollow;
      } else {
        freshRuns += runs; freshFailed += failed; freshHollow += hollow;
      }
    }
    const byRotation = await db.execute(sql`
      SELECT coalesce(hr.usage_json->>'sessionRotationReason', 'none') AS rotation_reason,
        count(*) AS runs,
        count(*) FILTER (WHERE hr.status <> 'succeeded') AS failed,
        count(*) FILTER (WHERE hr.liveness_state IN ${[...HOLLOW_LIVENESS_STATES]}) AS hollow
      FROM heartbeat_runs hr
      WHERE ${inWindow} AND (hr.usage_json->>'sessionReused') = 'true'
      GROUP BY 1
    `);
    const byModel = await db.execute(sql`
      SELECT coalesce(hr.usage_json->>'model', 'unknown') AS model,
        count(*) AS reused_runs,
        count(*) FILTER (WHERE hr.status <> 'succeeded') AS reused_failed
      FROM heartbeat_runs hr
      WHERE ${inWindow} AND (hr.usage_json->>'sessionReused') = 'true'
      GROUP BY 1
    `);
    return {
      reusedRuns,
      freshRuns,
      reusedFailureRate: reusedRuns > 0 ? reusedFailed / reusedRuns : null,
      freshFailureRate: freshRuns > 0 ? freshFailed / freshRuns : null,
      reusedHollowRate: reusedRuns > 0 ? reusedHollow / reusedRuns : null,
      freshHollowRate: freshRuns > 0 ? freshHollow / freshRuns : null,
      byRotationReason: rows(byRotation).map((r) => ({
        rotationReason: String(r.rotation_reason ?? "none"),
        runs: toNum(r.runs),
        failed: toNum(r.failed),
        hollow: toNum(r.hollow),
      })),
      byModel: rows(byModel).map((r) => ({
        model: String(r.model ?? "unknown"),
        reusedRuns: toNum(r.reused_runs),
        reusedFailed: toNum(r.reused_failed),
      })),
    };
  }

  /** Compute the full metric tree for one company/week. Idempotent (read-only). */
  async function computeWeek(
    companyId: string,
    opts?: { weekStart?: Date; now?: Date },
  ): Promise<MetricTreeWeek> {
    const now = opts?.now ?? new Date();
    const weekStart = opts?.weekStart ? isoWeekStart(opts.weekStart) : isoWeekStart(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const vcr = await runMetric("verifiedCompletionRate", () =>
      verifiedCompletionRate(companyId, weekStart, weekEnd, now));
    const verifiedCount = isError(vcr) ? 0 : vcr.verifiedCompletions;

    const [tokens, hollow, theater, babysitting, stall, session] = await Promise.all([
      runMetric("tokensPerVerified", () => tokensPerVerified(companyId, weekStart, weekEnd, verifiedCount)),
      runMetric("hollowSuccessRate", () => hollowSuccessRate(companyId, weekStart, weekEnd)),
      runMetric("dispositionTheater", () => dispositionTheater(companyId, weekStart, weekEnd, now)),
      runMetric("babysittingLoad", () => babysittingLoad(companyId, weekStart, weekEnd)),
      runMetric("stallHealth", () => stallHealth(companyId, weekStart, weekEnd)),
      runMetric("sessionResumeHealth", () => sessionResumeHealth(companyId, weekStart, weekEnd)),
    ]);

    return {
      companyId,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      generatedAt: now.toISOString(),
      verifiedCompletionRate: vcr,
      tokensPerVerified: tokens,
      hollowSuccessRate: hollow,
      dispositionTheater: theater,
      babysittingLoad: babysitting,
      stallHealth: stall,
      sessionResumeHealth: session,
    };
  }

  /**
   * Persist a computed week as an append-only JSON snapshot in activity_log.
   * Idempotent: a prior snapshot for the same (companyId, weekStart) is replaced so
   * re-runs converge on the latest computation while preserving cross-week history.
   */
  async function persistWeek(week: MetricTreeWeek): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM activity_log
        WHERE company_id = ${week.companyId}
          AND action = ${METRIC_TREE_SNAPSHOT_ACTION}
          AND entity_type = 'company' AND entity_id = ${week.companyId}
          AND details->>'weekStart' = ${week.weekStart}
      `);
      await tx.insert(activityLog).values({
        companyId: week.companyId,
        actorType: "system",
        actorId: "metric_tree",
        action: METRIC_TREE_SNAPSHOT_ACTION,
        entityType: "company",
        entityId: week.companyId,
        details: week as unknown as Record<string, unknown>,
      });
    });
  }

  /** Read the latest persisted snapshot for a company/week, if any. */
  async function getPersistedWeek(companyId: string, weekStart: Date): Promise<MetricTreeWeek | null> {
    const iso = isoWeekStart(weekStart).toISOString();
    const result = await db.execute(sql`
      SELECT details FROM activity_log
      WHERE company_id = ${companyId} AND action = ${METRIC_TREE_SNAPSHOT_ACTION}
        AND entity_type = 'company' AND entity_id = ${companyId}
        AND details->>'weekStart' = ${iso}
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? (row.details as unknown as MetricTreeWeek) : null;
  }

  function pickNumber(metric: unknown, key: string): number | null {
    if (!metric || typeof metric !== "object" || "error" in (metric as object)) return null;
    const v = (metric as Record<string, unknown>)[key];
    return typeof v === "number" ? v : null;
  }

  /** Compare current vs previous week and raise band-breach alerts. */
  function computeAlerts(
    current: MetricTreeWeek,
    previous: MetricTreeWeek | null,
    bands: MetricTreeAlertBands = DEFAULT_METRIC_TREE_ALERT_BANDS,
  ): MetricTreeAlert[] {
    if (!previous) return [];
    const alerts: MetricTreeAlert[] = [];

    const curHollow = pickNumber(current.hollowSuccessRate, "rate");
    const prevHollow = pickNumber(previous.hollowSuccessRate, "rate");
    if (curHollow != null && prevHollow != null && curHollow - prevHollow >= bands.hollowSuccessRatePointsUp) {
      alerts.push({
        metric: "hollowSuccessRate", direction: "up", previous: prevHollow, current: curHollow,
        delta: curHollow - prevHollow, threshold: bands.hollowSuccessRatePointsUp,
        message: `Hollow-success rate rose ${((curHollow - prevHollow) * 100).toFixed(1)}pts week-over-week`,
      });
    }

    const curVcr = pickNumber(current.verifiedCompletionRate, "rate");
    const prevVcr = pickNumber(previous.verifiedCompletionRate, "rate");
    if (curVcr != null && prevVcr != null && prevVcr - curVcr >= bands.vcrPointsDown) {
      alerts.push({
        metric: "verifiedCompletionRate", direction: "down", previous: prevVcr, current: curVcr,
        delta: curVcr - prevVcr, threshold: bands.vcrPointsDown,
        message: `Verified completion rate fell ${((prevVcr - curVcr) * 100).toFixed(1)}pts week-over-week`,
      });
    }

    const curTheater = pickNumber(current.dispositionTheater, "rate");
    const prevTheater = pickNumber(previous.dispositionTheater, "rate");
    if (curTheater != null && prevTheater != null && curTheater - prevTheater >= bands.dispositionTheaterRatePointsUp) {
      alerts.push({
        metric: "dispositionTheater", direction: "up", previous: prevTheater, current: curTheater,
        delta: curTheater - prevTheater, threshold: bands.dispositionTheaterRatePointsUp,
        message: `Disposition-theater rate rose ${((curTheater - prevTheater) * 100).toFixed(1)}pts week-over-week`,
      });
    }

    const curTpv = pickNumber(current.tokensPerVerified, "tokensPerVerifiedCompletion");
    const prevTpv = pickNumber(previous.tokensPerVerified, "tokensPerVerifiedCompletion");
    if (curTpv != null && prevTpv != null && prevTpv > 0 && (curTpv - prevTpv) / prevTpv >= bands.tokensPerVerifiedFractionUp) {
      alerts.push({
        metric: "tokensPerVerified", direction: "up", previous: prevTpv, current: curTpv,
        delta: curTpv - prevTpv, threshold: bands.tokensPerVerifiedFractionUp,
        message: `Tokens per verified completion rose ${(((curTpv - prevTpv) / prevTpv) * 100).toFixed(0)}% week-over-week`,
      });
    }

    return alerts;
  }

  /** Compute current + previous week and derive alerts (used by API + nightly job). */
  async function computeWithAlerts(
    companyId: string,
    opts?: { weekStart?: Date; now?: Date; bands?: MetricTreeAlertBands },
  ): Promise<MetricTreeWithAlerts> {
    const now = opts?.now ?? new Date();
    const weekStart = opts?.weekStart ? isoWeekStart(opts.weekStart) : isoWeekStart(now);
    const prevWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const current = await computeWeek(companyId, { weekStart, now });
    // Prefer a persisted previous week (stable baseline); fall back to recompute.
    const previous = (await getPersistedWeek(companyId, prevWeekStart))
      ?? (await computeWeek(companyId, { weekStart: prevWeekStart, now }));
    const alerts = computeAlerts(current, previous, opts?.bands);
    return { current, previous, alerts };
  }

  /**
   * Nightly job: for every company, compute the just-closed week, persist it, and
   * log any band-breach alerts. Safe to run repeatedly (persist is idempotent).
   */
  async function runNightly(opts?: { now?: Date; companyId?: string }): Promise<{
    companies: number;
    persisted: number;
    alerts: number;
    failed: number;
  }> {
    const now = opts?.now ?? new Date();
    const companyRows = rows(await db.execute(sql`
      SELECT id FROM companies
      ${opts?.companyId ? sql`WHERE id = ${opts.companyId}` : sql``}
    `));
    const summary = { companies: companyRows.length, persisted: 0, alerts: 0, failed: 0 };
    for (const row of companyRows) {
      const companyId = String(row.id);
      try {
        const { current, alerts } = await computeWithAlerts(companyId, { now });
        await persistWeek(current);
        summary.persisted += 1;
        summary.alerts += alerts.length;
        if (alerts.length > 0) {
          logger.warn({ companyId, weekStart: current.weekStart, alerts }, "metric-tree band breach detected");
        }
      } catch (err) {
        summary.failed += 1;
        logger.error({ err, companyId }, "metric-tree nightly computation failed for company");
      }
    }
    return summary;
  }

  return {
    computeWeek,
    computeWithAlerts,
    computeAlerts,
    persistWeek,
    getPersistedWeek,
    runNightly,
  };
}
