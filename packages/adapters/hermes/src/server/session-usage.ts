/**
 * Hermes session token metering (TOP-599).
 *
 * The Hermes CLI persists per-session usage counters in its SQLite session
 * store (`state.db` under the Hermes home — `$HERMES_HOME` when set, else
 * `~/.hermes`). The `sessions` row for a run's session id carries cumulative
 * input/output/cache token totals plus billing metadata. Reading those
 * counters lets the hermes_local adapter report real prompt/completion tokens
 * so the cost ledger can attribute burn to agent + provider (the stdout
 * usage regex in execute.ts never matches Hermes output and always yielded 0).
 *
 * Counters are cumulative across `--resume` continuations of the same
 * session: a resumed run updates the same row in place. The adapter
 * therefore reports SESSION totals and declares `usageBasis:
 * "session_cumulative"`; the server deltas consecutive runs of the session
 * (resolveNormalizedUsageForSession in server/src/services/heartbeat.ts).
 *
 * Best-effort by contract: any failure (missing store, locked DB, unknown
 * session) returns null and the caller falls back to stdout parsing. This
 * path is run-log-local data (the instance reads its own host's session
 * store); it is not a Telemetry or Observability path.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface HermesSessionUsage {
  /** Non-cached prompt tokens plus cache-write tokens (billed as prompt). */
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens (cache hits on the prompt side). */
  cachedInputTokens: number;
  /** Cumulative estimated USD reported by Hermes, when present. */
  estimatedCostUsd: number | null;
  /** Billing provider recorded by Hermes (e.g. "xiaomi", "minimax"). */
  billingProvider: string | null;
}

/**
 * Resolve the Hermes session store path from the same environment the
 * hermes child process receives: HERMES_HOME points at the active profile
 * home (its state.db lives directly inside), otherwise the default home is
 * `$HOME/.hermes`.
 */
export function resolveHermesStateDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
  return join(home, "state.db");
}

function asCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Read cumulative usage for one session id from the Hermes session store.
 * Returns null when the store or session is unavailable, or when the row
 * carries no tokens yet (so callers can keep their stdout fallback).
 */
export function readHermesSessionUsage(
  stateDbPath: string,
  sessionId: string,
): HermesSessionUsage | null {
  if (!sessionId) return null;
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, billing_provider
           FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const inputTokens = asCount(row.input_tokens);
    const outputTokens = asCount(row.output_tokens);
    const cachedReadTokens = asCount(row.cache_read_tokens);
    const cachedWriteTokens = asCount(row.cache_write_tokens);
    if (inputTokens <= 0 && outputTokens <= 0 && cachedReadTokens <= 0 && cachedWriteTokens <= 0) {
      return null;
    }

    // Cache-write tokens are prompt tokens the provider billed to create
    // cache entries; UsageSummary has no dedicated field, so they count as
    // input (same convention as summarizeAcpxTurnUsage in adapter-utils).
    const costRaw = Number(row.estimated_cost_usd);
    return {
      inputTokens: inputTokens + cachedWriteTokens,
      outputTokens,
      cachedInputTokens: cachedReadTokens,
      estimatedCostUsd: Number.isFinite(costRaw) && costRaw > 0 ? costRaw : null,
      billingProvider:
        typeof row.billing_provider === "string" && row.billing_provider
          ? row.billing_provider
          : null,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close; nothing to clean up beyond this.
    }
  }
}
