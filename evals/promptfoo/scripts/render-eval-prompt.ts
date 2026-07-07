// Renders the promptfoo heartbeat eval prompt from the SHIPPED agent-prompt
// template, so the eval always exercises the real prompt instead of a
// hand-maintained fork that silently drifts.
//
// Source of truth: `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` and
// `renderPaperclipWakePrompt` in packages/adapter-utils. This mirrors how the
// local adapters compose the agent prompt (see e.g.
// packages/adapters/claude-local/src/server/execute.ts): the rendered wake
// payload followed by the rendered agent-prompt template, joined the same way.
//
// The output is committed at `prompts/heartbeat-system.generated.txt` and
// guarded by a byte-parity check (see eval-prompt.ts `check`). Do not hand-edit
// the generated file — change the shipped template (or the fixtures below) and
// regenerate.
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "../../../packages/adapter-utils/src/server-utils.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the committed, generated eval prompt. */
export const EVAL_PROMPT_PATH = path.resolve(
  scriptDir,
  "..",
  "prompts",
  "heartbeat-system.generated.txt",
);

// Fixtures are static and value-only (no timestamps / randomness) so the
// generated prompt is deterministic and byte-stable across machines. Concrete
// values — not `{{...}}` placeholders — because that is what a real agent
// actually receives, which is the whole point of prompt parity.
export const EVAL_AGENT_FIXTURE = {
  id: "agent-eval-01",
  name: "Eval Agent",
} as const;

export const EVAL_WAKE_FIXTURE = {
  reason: "issue_assigned",
  issue: {
    identifier: "EVAL-1",
    title: "sample heartbeat eval issue",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
  },
  checkedOutByHarness: true,
  commentWindow: { requestedCount: 0, includedCount: 0 },
} as const;

/**
 * Render the eval system prompt exactly from the shipped exports. Returns the
 * exact bytes that must be committed to `EVAL_PROMPT_PATH`.
 */
export function renderEvalHeartbeatPrompt(): string {
  const wakePrompt = renderPaperclipWakePrompt(EVAL_WAKE_FIXTURE);
  const agentPrompt = renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, {
    agent: EVAL_AGENT_FIXTURE,
  });
  return joinPromptSections([wakePrompt, agentPrompt]) + "\n";
}
