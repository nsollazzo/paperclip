// CLI for the promptfoo heartbeat eval prompt.
//
//   generate  Render the eval prompt from the shipped template and write it to
//             prompts/heartbeat-system.generated.txt.
//   check     Fail (exit 1) if the committed prompt differs byte-for-byte from
//             a fresh render. This is the CI gate: editing the shipped template
//             without regenerating breaks the build.
//
// Run via tsx, e.g. `pnpm evals:heartbeat-prompt:check`.
import fs from "node:fs";
import path from "node:path";

import { EVAL_PROMPT_PATH, renderEvalHeartbeatPrompt } from "./render-eval-prompt.ts";

const REGEN_HINT = "Run `pnpm evals:heartbeat-prompt:generate` and commit the result.";

function generate(): void {
  const rendered = renderEvalHeartbeatPrompt();
  fs.mkdirSync(path.dirname(EVAL_PROMPT_PATH), { recursive: true });
  fs.writeFileSync(EVAL_PROMPT_PATH, rendered);
  console.log(`Wrote ${path.relative(process.cwd(), EVAL_PROMPT_PATH)} (${rendered.length} bytes).`);
}

function check(): void {
  const expected = renderEvalHeartbeatPrompt();
  let actual: string | null = null;
  try {
    actual = fs.readFileSync(EVAL_PROMPT_PATH, "utf8");
  } catch {
    actual = null;
  }
  const rel = path.relative(process.cwd(), EVAL_PROMPT_PATH);
  if (actual === null) {
    console.error(`Eval prompt is missing: ${rel}\n${REGEN_HINT}`);
    process.exit(1);
  }
  if (actual !== expected) {
    console.error(
      `Eval prompt is out of date: ${rel} does not match the shipped template.\n${REGEN_HINT}`,
    );
    process.exit(1);
  }
  console.log(`Eval prompt is in sync with the shipped template: ${rel}`);
}

const mode = process.argv[2];
if (mode === "generate") {
  generate();
} else if (mode === "check") {
  check();
} else {
  console.error("Usage: eval-prompt.ts <generate|check>");
  process.exit(2);
}
