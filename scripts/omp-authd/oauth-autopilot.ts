/**
 * oauth-autopilot — in-session trigger for the standalone omp-authd driver.
 *
 * Scope note: the OAuth URL never reaches extension APIs (omp's /login panel
 * calls xdg-open directly), so the actual browser work lives in
 * ~/.local/bin/omp-authd (a symlink to scripts/omp-authd/omp-authd), which works
 * even when no omp session exists. This extension only adds the two things an
 * extension can uniquely provide:
 *
 *   1. `/gauth [provider]` — start/finish a provider sign-in from inside the
 *      session and report the outcome in the transcript.
 *   2. auto re-auth on `credential_disabled`, which omp emits when it disables
 *      a credential after a hard auth rejection — the exact moment the user
 *      would otherwise have to drop everything and click through Google.
 *
 * Google providers only; other providers' flows are left alone.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = process.env.OMP_AUTHD_BIN ?? join(homedir(), ".local/bin/omp-authd");
const GOOGLE_PROVIDER: Record<string, true> = {
  "google-antigravity": true,
  "google-gemini-cli": true,
  google: true,
};
const COOLDOWN_MS = 5 * 60_000;
const lastAttempt: Record<string, number> = {};

function providerOf(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record: Record<string, unknown> = model as Record<string, unknown>;
  return typeof record.provider === "string" ? record.provider : undefined;
}

function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "see ~/.cache/omp-authd/logs";
}

/**
 * Run `omp-authd login <provider>` to completion. The helper spawns
 * `omp auth-broker login`, captures the authorize URL from its stdout, drives
 * real Chrome over CDP, and exits once omp has written the credential.
 */
function runLogin(provider: string, timeoutMs = 240_000): Promise<{ ok: boolean; output: string }> {
  lastAttempt[provider] = Date.now();
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>();
  const child = spawn(BIN, ["login", provider], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    resolve({ ok: false, output: output || `timed out after ${timeoutMs}ms` });
  }, timeoutMs);
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (e: Error) => {
    clearTimeout(timer);
    resolve({ ok: false, output: e.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ ok: code === 0, output });
  });
  return promise;
}

export default function (pi: ExtensionAPI) {
  if (!existsSync(BIN)) {
    pi.logger.warn(`oauth-autopilot: driver missing at ${BIN}`);
    return;
  }

  pi.registerCommand("gauth", {
    description: "Sign a Google provider back in without touching the browser",
    handler: async (args, ctx) => {
      const provider = (args || "").trim() || providerOf(ctx.models.current() ?? ctx.model) || "google-antigravity";
      if (!GOOGLE_PROVIDER[provider]) {
        ctx.ui.notify(`oauth-autopilot only handles Google providers (got "${provider}")`, "warning");
        return;
      }
      ctx.ui.notify(`Driving ${provider} sign-in in Chrome…`, "info");
      const res = await runLogin(provider);
      ctx.ui.notify(
        res.ok ? `${provider}: credential saved` : `${provider}: sign-in failed — ${lastLine(res.output)}`,
        res.ok ? "info" : "error",
      );
    },
  });

  pi.on("credential_disabled", async (event, ctx) => {
    const provider = providerOf(event) ?? "";
    if (Date.now() - (lastAttempt[provider] ?? 0) < COOLDOWN_MS) {
      ctx.ui.notify(`${provider} credential disabled; autopilot already ran for it in the last 5 minutes`, "warning");
      return;
    }
    ctx.ui.notify(`${provider} credential disabled — re-running the browser sign-in automatically`, "warning");
    const res = await runLogin(provider);
    ctx.ui.notify(
      res.ok ? `${provider}: re-authenticated` : `${provider}: automatic re-auth failed — ${lastLine(res.output)}`,
      res.ok ? "info" : "error",
    );
  });
}
