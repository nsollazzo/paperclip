// Reads the DB end-state back over the API after a heartbeat run and normalizes
// it into an EndStateSnapshot for the hard checks. All routes are confirmed in
// server/src/routes/issues.ts and server/src/routes/activity.ts.

import type { ApiClient } from "./api.js";
import type {
  ActivityEventSnapshot,
  CommentSnapshot,
  EndStateSnapshot,
  IssueSnapshot,
  RunSnapshot,
  RunStatus,
  WorkProductSnapshot,
} from "./types.js";

interface RawIssue {
  id: string;
  identifier: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockedBy?: Array<{ id: string; identifier?: string; status?: string }>;
}
interface RawComment {
  id: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
  createdByRunId?: string | null;
}
interface RawWorkProduct {
  id: string;
  type: string;
  title?: string | null;
  createdByRunId?: string | null;
}
interface RawActivity {
  action: string;
  createdAt: string;
  agentId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
}
interface RawRun {
  id: string;
  status: RunStatus;
  error?: string | null;
}

export interface ReadEndStateArgs {
  api: ApiClient;
  companyId: string;
  agentUnderTestId: string;
  runId: string;
  /** Null for no-work / no-issue scenarios. */
  issueId: string | null;
  wakeCommentId?: string | null;
  wakeCommentBody?: string | null;
}

/** Poll the heartbeat run until it reaches a terminal status (or times out). */
export async function waitForRunTerminal(
  api: ApiClient,
  companyId: string,
  agentId: string,
  runId: string,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const terminal = new Set<RunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
  const deadline = Date.now() + timeoutMs;
  let last: RawRun | null = null;
  while (Date.now() < deadline) {
    const runs = (await api.get<RawRun[]>(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}`)) ?? [];
    last = runs.find((r) => r && r.id === runId) ?? last;
    if (last && terminal.has(last.status)) {
      return { id: last.id, status: last.status, error: last.error ?? null };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { id: runId, status: last?.status === "succeeded" ? "succeeded" : "timed_out", error: "poll timed out" };
}

export async function readEndState(args: ReadEndStateArgs, run: RunSnapshot): Promise<EndStateSnapshot> {
  const { api, agentUnderTestId, runId, issueId } = args;

  let issue: IssueSnapshot | null = null;
  let comments: CommentSnapshot[] = [];
  let workProducts: WorkProductSnapshot[] = [];
  let activity: ActivityEventSnapshot[] = [];

  if (issueId) {
    const raw = await api.get<RawIssue>(`/api/issues/${issueId}`);
    issue = {
      id: raw.id,
      identifier: raw.identifier,
      status: raw.status,
      assigneeAgentId: raw.assigneeAgentId ?? null,
      assigneeUserId: raw.assigneeUserId ?? null,
      blockedBy: (raw.blockedBy ?? []).map((b) => ({ id: b.id, identifier: b.identifier, status: b.status })),
    };

    const rawComments = (await api.get<RawComment[]>(`/api/issues/${issueId}/comments`)) ?? [];
    // Run-scoped: only what this heartbeat authored.
    comments = rawComments
      .filter((c) => c.createdByRunId === runId)
      .map((c) => ({
        id: c.id,
        authorAgentId: c.authorAgentId ?? null,
        authorUserId: c.authorUserId ?? null,
        body: c.body ?? "",
        createdAt: c.createdAt,
      }));

    const rawWps = (await api.get<RawWorkProduct[]>(`/api/issues/${issueId}/work-products`)) ?? [];
    // Run-scoped, symmetric with comments: only artifacts this heartbeat authored.
    // The server forces createdByRunId to the agent's run on agent-created work
    // products (issues.ts resolveWorkProductCreatedByRunId), so strict matching
    // never drops the agent-under-test's fresh artifact while excluding pre-seeded
    // or board-created (null run-id) rows that would false-pass doneRequiresArtifact.
    workProducts = rawWps
      .filter((w) => w.createdByRunId === runId)
      .map((w) => ({ id: w.id, type: w.type, title: w.title ?? null }));

    const rawActivity = (await api.get<RawActivity[]>(`/api/issues/${issueId}/activity`)) ?? [];
    activity = rawActivity
      .map((a) => ({
        type: a.action,
        createdAt: a.createdAt,
        actorAgentId: a.agentId ?? a.actorId ?? null,
      }))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  }

  return {
    agentUnderTestId,
    wakeCommentId: args.wakeCommentId ?? null,
    wakeCommentBody: args.wakeCommentBody ?? null,
    run,
    issue,
    comments,
    workProducts,
    activity,
  };
}
