// Boots a throwaway local_trusted Paperclip server for the live scenario suite,
// mirroring tests/e2e/playwright.config.ts. Or attaches to an already-running
// server when PAPERCLIP_SCENARIO_BASE_URL is set (cheaper for iteration).

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunningServer {
  baseUrl: string;
  apiKey: string;
  stop(): Promise<void>;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

/**
 * Returns a live server. If PAPERCLIP_SCENARIO_BASE_URL is set, attaches to it
 * (no lifecycle ownership). Otherwise boots a throwaway instance via
 * `pnpm paperclipai onboard --yes --run` on PAPERCLIP_SCENARIO_PORT (default
 * 3299) in a temp PAPERCLIP_HOME.
 */
export async function startScenarioServer(): Promise<RunningServer> {
  const attachUrl = process.env.PAPERCLIP_SCENARIO_BASE_URL;
  const apiKey = process.env.PAPERCLIP_SCENARIO_API_KEY ?? "";
  if (attachUrl) {
    await waitForHealth(attachUrl, 30_000);
    return { baseUrl: attachUrl, apiKey, stop: async () => {} };
  }

  const port = Number(process.env.PAPERCLIP_SCENARIO_PORT ?? 3299);
  const baseUrl = `http://127.0.0.1:${port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-scenario-home-"));
  const child: ChildProcess = spawn("pnpm", ["paperclipai", "onboard", "--yes", "--run"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PORT: String(port),
      PAPERCLIP_HOME: home,
      PAPERCLIP_INSTANCE_ID: "scenario-evals",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  });

  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill("SIGTERM");
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  try {
    await waitForHealth(baseUrl, 120_000);
  } catch (err) {
    await stop();
    throw err;
  }
  return { baseUrl, apiKey, stop };
}
