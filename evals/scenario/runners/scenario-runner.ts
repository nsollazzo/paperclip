// Live scenario runner for the Phase 1 disposition-truth suite (POS-175).
//
// Boots a real local_trusted server, seeds a company/agent/issue, triggers a
// REAL wake, waits for the heartbeat run to reach a terminal status, reads the
// DB end-state back over the API, and asserts the deterministic hard checks.
//
//   pnpm evals:scenario:live                 # all scenarios
//   pnpm evals:scenario:live -- core.blocked_requires_blocker_or_owner
//
// Requires a real model credential for the seeded agent's adapter (see
// evals/scenario/README.md for the runbook and cost per run). Exits non-zero on
// any scenario failure so it can gate a release.

import { ApiClient } from "../lib/api.js";
import { readEndState, waitForRunTerminal } from "../lib/end-state.js";
import { startScenarioServer } from "../lib/server.js";
import type { CheckResult, RunStatus } from "../lib/types.js";
import { SCENARIOS, resolveChecks, type LiveScenario } from "../cases.js";

const RUN_TIMEOUT_MS = Number(process.env.PAPERCLIP_SCENARIO_RUN_TIMEOUT_MS ?? 300_000);
const MODEL_PROFILE = process.env.PAPERCLIP_SCENARIO_MODEL_PROFILE ?? "cheap";

interface Company {
  id: string;
  identifier?: string;
}
interface Agent {
  id: string;
  name: string;
  adapterType: string | null;
  companyId: string;
}
interface Issue {
  id: string;
  identifier: string;
}
interface Comment {
  id: string;
  body: string;
}
interface Run {
  id: string;
  status: RunStatus;
  createdAt?: string;
  usageJson?: { costUsd?: number; totalTokens?: number } | null;
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function resolveCompanyAndAgent(api: ApiClient): Promise<{ company: Company; agent: Agent }> {
  const companies = (await api.get<Company[]>(`/api/companies`)) ?? [];
  if (companies.length === 0) throw new Error("no seeded company found on the server");
  const company = companies[0];
  const agents = (await api.get<Agent[]>(`/api/companies/${company.id}/agents`)) ?? [];
  // Prefer a real model-backed adapter (not the `process`/`http` fakes).
  const real = agents.find((a) => a.adapterType && !["process", "http"].includes(a.adapterType));
  const agent = real ?? agents[0];
  if (!agent) throw new Error(`no agent found in company ${company.id}`);
  if (!real) {
    log(`⚠ no real model-backed adapter found; using ${agent.adapterType ?? "unknown"} adapter (${agent.name})`);
  }
  return { company, agent };
}

async function existingRunIds(api: ApiClient, companyId: string, agentId: string): Promise<Set<string>> {
  const runs = (await api.get<Run[]>(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}`)) ?? [];
  return new Set(runs.map((r) => r.id));
}

/** Poll for a heartbeat run that did not exist before the wake was triggered. */
async function waitForNewRunId(
  api: ApiClient,
  companyId: string,
  agentId: string,
  before: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = (await api.get<Run[]>(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}`)) ?? [];
    const fresh = runs.find((r) => !before.has(r.id));
    if (fresh) return fresh.id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no new heartbeat run appeared after the wake was triggered");
}

async function seedIssue(
  api: ApiClient,
  companyId: string,
  agentId: string,
  scenario: LiveScenario,
): Promise<Issue> {
  const seed = scenario.seed!;
  return api.post<Issue>(`/api/companies/${companyId}/issues`, {
    title: seed.title,
    description: seed.description,
    status: seed.status ?? "todo",
    priority: seed.priority ?? "medium",
    assigneeAgentId: agentId,
    assigneeAdapterOverrides: { modelProfile: MODEL_PROFILE },
  });
}

interface ScenarioOutcome {
  scenario: LiveScenario;
  runStatus: RunStatus;
  checks: CheckResult[];
  pass: boolean;
  costUsd: number | null;
}

async function runScenario(
  api: ApiClient,
  company: Company,
  agent: Agent,
  scenario: LiveScenario,
): Promise<ScenarioOutcome> {
  log(`\n▶ ${scenario.id}`);
  const before = await existingRunIds(api, company.id, agent.id);
  let issueId: string | null = null;
  let wakeCommentId: string | null = null;
  let wakeCommentBody: string | null = null;

  if (scenario.wake.kind === "timer") {
    await api.post(`/api/agents/${agent.id}/wakeup`, { source: "timer", triggerDetail: "system" });
  } else {
    const issue = await seedIssue(api, company.id, agent.id, scenario);
    issueId = issue.id;
    log(`  seeded issue ${issue.identifier}`);
    if (scenario.wake.kind === "comment") {
      // Let the assignment run settle, then post the wake comment.
      const firstRun = await waitForNewRunId(api, company.id, agent.id, before, RUN_TIMEOUT_MS);
      await waitForRunTerminal(api, company.id, agent.id, firstRun, RUN_TIMEOUT_MS);
      const settled = await existingRunIds(api, company.id, agent.id);
      const comment = await api.post<Comment>(`/api/issues/${issueId}/comments`, { body: scenario.wake.commentBody });
      wakeCommentId = comment.id;
      wakeCommentBody = comment.body;
      const runId = await waitForNewRunId(api, company.id, agent.id, settled, RUN_TIMEOUT_MS);
      return finalizeScenario(api, company, agent, scenario, issueId, runId, wakeCommentId, wakeCommentBody);
    }
  }

  const runId = await waitForNewRunId(api, company.id, agent.id, before, RUN_TIMEOUT_MS);
  return finalizeScenario(api, company, agent, scenario, issueId, runId, wakeCommentId, wakeCommentBody);
}

async function finalizeScenario(
  api: ApiClient,
  company: Company,
  agent: Agent,
  scenario: LiveScenario,
  issueId: string | null,
  runId: string,
  wakeCommentId: string | null,
  wakeCommentBody: string | null,
): Promise<ScenarioOutcome> {
  const run = await waitForRunTerminal(api, company.id, agent.id, runId, RUN_TIMEOUT_MS);
  const snap = await readEndState(
    { api, companyId: company.id, agentUnderTestId: agent.id, runId, issueId, wakeCommentId, wakeCommentBody },
    run,
  );
  const checks = resolveChecks(scenario.checkIds).map((c) => c(snap));
  const pass = run.status === "succeeded" && checks.every((c) => c.pass);

  const runs = (await api.get<Run[]>(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`)) ?? [];
  const costUsd = runs.find((r) => r.id === runId)?.usageJson?.costUsd ?? null;

  for (const c of checks) {
    log(`  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.reason}`);
  }
  log(`  run=${run.status}${costUsd != null ? ` cost=$${costUsd.toFixed(4)}` : ""} → ${pass ? "PASS" : "FAIL"}`);
  return { scenario, runStatus: run.status, checks, pass, costUsd };
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = filter.length > 0 ? SCENARIOS.filter((s) => filter.includes(s.id)) : SCENARIOS;
  if (selected.length === 0) {
    log(`no scenarios matched ${JSON.stringify(filter)}`);
    process.exit(2);
  }

  const server = await startScenarioServer();
  log(`server: ${server.baseUrl}`);
  const api = new ApiClient({ baseUrl: server.baseUrl, apiKey: server.apiKey });

  const outcomes: ScenarioOutcome[] = [];
  try {
    const { company, agent } = await resolveCompanyAndAgent(api);
    log(`company=${company.identifier ?? company.id} agent=${agent.name} adapter=${agent.adapterType}`);
    for (const scenario of selected) {
      try {
        outcomes.push(await runScenario(api, company, agent, scenario));
      } catch (err) {
        log(`  ✗ scenario error: ${(err as Error).message}`);
        outcomes.push({
          scenario,
          runStatus: "failed",
          checks: [],
          pass: false,
          costUsd: null,
        });
      }
    }
  } finally {
    await server.stop();
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const totalCost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  log(`\n${"=".repeat(60)}`);
  log(`SCENARIO SUITE: ${passed}/${outcomes.length} passed | total cost ~$${totalCost.toFixed(4)}`);
  for (const o of outcomes) log(`  ${o.pass ? "PASS" : "FAIL"}  ${o.scenario.id}`);
  process.exit(passed === outcomes.length ? 0 : 1);
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
