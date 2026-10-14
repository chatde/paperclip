/**
 * TOP-599: hermes_local token metering reads cumulative per-session usage
 * counters from the Hermes SQLite session store so prompt/completion tokens
 * land in the cost ledger attributed to agent + provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readHermesSessionUsage,
  resolveHermesStateDbPath,
} from "./session-usage.js";

let home: string;

function seedSession(row: Record<string, unknown>) {
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    billing_provider TEXT
  )`);
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, billing_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id as string,
    (row.input_tokens as number) ?? 0,
    (row.output_tokens as number) ?? 0,
    (row.cache_read_tokens as number) ?? 0,
    (row.cache_write_tokens as number) ?? 0,
    (row.estimated_cost_usd as number) ?? null,
    (row.billing_provider as string) ?? null,
  );
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hermes-session-usage-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveHermesStateDbPath", () => {
  it("prefers HERMES_HOME (profile home) over the default home", () => {
    expect(resolveHermesStateDbPath({ HERMES_HOME: "/x/profiles/p", HOME: "/y" })).toBe(
      "/x/profiles/p/state.db",
    );
  });

  it("falls back to $HOME/.hermes", () => {
    expect(resolveHermesStateDbPath({ HOME: "/y" })).toBe("/y/.hermes/state.db");
  });
});

describe("readHermesSessionUsage", () => {
  it("maps session counters to UsageSummary fields", () => {
    seedSession({
      id: "s1",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 10,
      estimated_cost_usd: 0.5,
      billing_provider: "xiaomi",
    });
    const usage = readHermesSessionUsage(join(home, "state.db"), "s1");
    expect(usage).toEqual({
      // cache-write tokens count as billed prompt tokens (input)
      inputTokens: 110,
      outputTokens: 20,
      cachedInputTokens: 30,
      estimatedCostUsd: 0.5,
      billingProvider: "xiaomi",
    });
  });

  it("returns null for an unknown session", () => {
    seedSession({ id: "s1", input_tokens: 1, output_tokens: 1 });
    expect(readHermesSessionUsage(join(home, "state.db"), "missing")).toBeNull();
  });

  it("returns null when the session has no tokens yet", () => {
    seedSession({ id: "s1" });
    expect(readHermesSessionUsage(join(home, "state.db"), "s1")).toBeNull();
  });

  it("returns null when the store is missing or unreadable", () => {
    expect(
      readHermesSessionUsage(join(home, "no-such.db"), "s1"),
    ).toBeNull();
    expect(readHermesSessionUsage(join(home, "state.db"), "")).toBeNull();
  });

  it("reports cumulative totals across resumed runs (server deltas)", () => {
    seedSession({
      id: "s1",
      input_tokens: 4246,
      output_tokens: 11,
      cache_read_tokens: 16384,
    });
    const first = readHermesSessionUsage(join(home, "state.db"), "s1");
    seedSession({
      id: "s1",
      input_tokens: 4291,
      output_tokens: 23,
      cache_read_tokens: 36992,
    });
    const second = readHermesSessionUsage(join(home, "state.db"), "s1");
    // The row is cumulative; the adapter reports totals and the server
    // session-deltas consecutive runs.
    expect(first?.outputTokens).toBe(11);
    expect(second?.outputTokens).toBe(23);
    expect(second?.cachedInputTokens).toBe(36992);
  });
});
