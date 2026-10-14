/**
 * TOP-599: hermes_local reports prompt/completion tokens from the Hermes
 * session store (cumulative session totals, session-delta'd by the server)
 * and keeps the stdout regex as the fallback.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

import { execute } from "./execute.js";

let home: string;

function seedSession(row: {
  id: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}) {
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
       (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.input_tokens ?? 0,
    row.output_tokens ?? 0,
    row.cache_read_tokens ?? 0,
    row.cache_write_tokens ?? 0,
  );
  db.close();
}

function makeCtx() {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      env: { HERMES_HOME: home },
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as any;
}

function mockRun(stdout: string) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: null,
    startedAt: null,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "hermes-execute-usage-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hermes-local execute token metering", () => {
  it("reports session-store usage as session_cumulative totals", async () => {
    seedSession({
      id: "session-abc",
      input_tokens: 4291,
      output_tokens: 23,
      cache_read_tokens: 36992,
      cache_write_tokens: 5,
    });
    mockRun("all done\n\nsession_id: session-abc\n");

    const result = await execute(makeCtx());

    expect(result.usage).toEqual({
      inputTokens: 4296,
      outputTokens: 23,
      cachedInputTokens: 36992,
    });
    expect(result.usageBasis).toBe("session_cumulative");
    expect((result.resultJson as any).usage).toEqual(result.usage);
  });

  it("prefers the session store over the stdout regex", async () => {
    seedSession({ id: "session-abc", input_tokens: 10, output_tokens: 2 });
    mockRun(
      "tokens: 99 input and 88 output\nall done\n\nsession_id: session-abc\n",
    );

    const result = await execute(makeCtx());

    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
  });

  it("falls back to the stdout regex when the store has no row", async () => {
    mockRun(
      "tokens: 99 input and 88 output\nall done\n\nsession_id: unknown-session\n",
    );

    const result = await execute(makeCtx());

    expect(result.usage).toEqual({ inputTokens: 99, outputTokens: 88 });
    expect(result.usageBasis).toBeUndefined();
  });

  it("reports no usage when neither source has tokens", async () => {
    mockRun("all done\n\nsession_id: session-abc\n");

    const result = await execute(makeCtx());

    expect(result.usage).toBeUndefined();
  });
});
