import { defineConfig } from "vitest/config";

// Standalone config for the Phase 1 scenario-eval harness. Deliberately NOT a
// member of the root vitest `projects` list: the deterministic guard tests
// (*.test.ts) are cheap and safe, but the live suite boots a real server and a
// real model, so it must never run inside the default `pnpm test`. Invoke via:
//   pnpm evals:scenario        # deterministic guards only (green, free)
//   pnpm evals:scenario:live   # full live suite (needs a model credential)
export default defineConfig({
  // Bypass workspace tsconfig project-reference resolution: the harness is a
  // standalone, dependency-free TS module and does not need the monorepo's
  // composite tsconfig graph.
  esbuild: { tsconfigRaw: "{}" },
  test: {
    include: ["scorers/**/*.test.ts"],
    // The live runner is a script (runners/scenario-runner.ts), not a vitest
    // spec, so nothing model-dependent is picked up here.
  },
});
