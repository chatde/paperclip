/**
 * TOP-396: timeout/crash errorReason classification for the hermes-local
 * adapter.
 *
 * Symptom (TOP-177 symptom 3): a run timeout SIGINT makes hermes raise
 * KeyboardInterrupt mid cli.chat(), and its traceback contributes only the
 * bare "Traceback (most recent call last):" header to the stderr error
 * matcher, which then landed verbatim in agents.errorReason.
 *
 * Contract under test:
 * - A timed-out run never surfaces parsed traceback text (timeout
 *   diagnostics stay with the heartbeat timeout path, which stores the
 *   classified "timed out after Ns (run budget exceeded)" reason).
 * - A genuine crash keeps its real error line, preferring the last matching
 *   stderr line over the bare traceback header when more than one matches.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from so
// no real child process spawns.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
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

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const BARE_TRACEBACK_HEADER = "Traceback (most recent call last):";

function makeCtx() {
  return {
    runId: "test-run-timeout-reason",
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

function mockChild(result: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
}) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: null,
    ...result,
  } as any);
}

describe("hermes-local adapter timeout errorReason (TOP-396)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not surface the bare traceback head for a timeout settle", async () => {
    mockChild({
      exitCode: null,
      signal: "SIGINT",
      timedOut: true,
      stderr: `${BARE_TRACEBACK_HEADER}\nKeyboardInterrupt\n`,
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  it("does not surface any parsed error text for a timeout settle", async () => {
    mockChild({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stderr: "ValueError: late failure before the kill\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  it("keeps the traceback tail for a genuine crash (last frames + exception line, TOP-596)", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: [
        BARE_TRACEBACK_HEADER,
        '  File "cli.py", line 12, in <module>',
        "ValueError: boom",
        "",
      ].join("\n"),
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe(
      [
        BARE_TRACEBACK_HEADER,
        '  File "cli.py", line 12, in <module>',
        "ValueError: boom",
      ].join("\n"),
    );
  });

  it("keeps the traceback tail when no exception line matched (genuine non-timeout crash, TOP-596)", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: `${BARE_TRACEBACK_HEADER}\n  File "cli.py", line 12, in <module>\n`,
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe(
      `${BARE_TRACEBACK_HEADER}\n  File "cli.py", line 12, in <module>`,
    );
  });
});
