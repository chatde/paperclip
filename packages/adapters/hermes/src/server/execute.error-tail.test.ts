/**
 * TOP-596: run.error must carry the diagnosable tail of a failure.
 *
 * Class 3: a non-zero Hermes exit used to record only "Hermes exited with
 * code N" and drop the failure body, which Hermes writes to stdout for some
 * failure families (e.g. provider quota errors) and to stderr for others.
 * run.error now carries a bounded tail of both streams.
 *
 * Class 4: a Python traceback used to truncate at the bare
 * "Traceback (most recent call last):" header (or a single matched line) and
 * lose the exception tail. run.error now keeps the tail of the traceback —
 * the last frames plus the final exception line.
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

function makeCtx() {
  return {
    runId: "test-run-error-tail",
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

describe("hermes-local adapter diagnosable error tails (TOP-596)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("class 3: a non-zero exit with the failure body on stdout keeps a stdout tail", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout:
        "API call failed after 3 retries: HTTP 429: RESOURCE_EXHAUSTED: You exceeded your current quota.\n",
      stderr: "session_id: 20261013_044318_0dd585\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toContain("Hermes exited with code 1");
    expect(result.errorMessage).toContain("--- stdout tail ---");
    expect(result.errorMessage).toContain("HTTP 429: RESOURCE_EXHAUSTED");
    // Benign session_id noise is not a diagnosis.
    expect(result.errorMessage).not.toContain("session_id:");
  });

  it("class 3: a non-zero exit with an unparseable stderr body keeps a stderr tail", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "upstream unavailable (connection reset by peer)\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe(
      "Hermes exited with code 1\n--- stderr tail ---\nupstream unavailable (connection reset by peer)",
    );
  });

  it("class 3: keeps the parsed error line when the stderr matcher already found the reason", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: cannot load config: ENOENT: no such file or directory\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe(
      "Error: cannot load config: ENOENT: no such file or directory",
    );
  });

  it("class 3: keeps the bare exit line when both streams are benign or empty", async () => {
    mockChild({
      exitCode: 2,
      signal: null,
      timedOut: false,
      stdout: "[hermes] Starting Hermes Agent\n",
      stderr: "",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe("Hermes exited with code 2");
  });

  it("class 3: bounds the tail and marks the elision", async () => {
    const noise = Array.from({ length: 400 }, (_, i) => `filler line ${i}`).join("\n");
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `${noise}\nfinal failure: out of memory\n`,
      stderr: "",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toContain("[... earlier output elided ...]");
    expect(result.errorMessage).toContain("final failure: out of memory");
    expect(result.errorMessage!.length).toBeLessThan(8 * 1024);
  });

  it("class 4: a traceback keeps the last frames and the exception line", async () => {
    mockChild({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stderr: [
        "Traceback (most recent call last):",
        '  File "/app/cli.py", line 12805, in main',
        "    result = cli.agent.run_conversation(",
        '  File "/app/run_agent.py", line 9812, in _execute_tool_calls',
        "    return self._execute_tool_calls_sequential(",
        '  File "/app/run_agent.py", line 10627, in _execute_tool_calls_sequential',
        "    function_result = handle_function_call(",
        "SomeInternalProblem: registry dispatch failed",
        "",
      ].join("\n"),
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toContain("Traceback (most recent call last):");
    expect(result.errorMessage).toContain("_execute_tool_calls_sequential");
    expect(result.errorMessage).toContain("SomeInternalProblem: registry dispatch failed");
  });

  it("class 4: a header-only traceback no longer truncates at the header line", async () => {
    // The exception line (KeyboardInterrupt) does not match the legacy
    // /error|exception|traceback|failed/ filter, so the old parser kept only
    // the bare header. TOP-596 keeps the whole tail.
    mockChild({
      exitCode: null,
      signal: null,
      timedOut: false,
      stderr: [
        "Traceback (most recent call last):",
        '  File "/app/cli.py", line 12766, in _signal_handler_q',
        "    raise KeyboardInterrupt()",
        "KeyboardInterrupt",
        "",
      ].join("\n"),
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe(
      [
        "Traceback (most recent call last):",
        '  File "/app/cli.py", line 12766, in _signal_handler_q',
        "    raise KeyboardInterrupt()",
        "KeyboardInterrupt",
      ].join("\n"),
    );
  });

  it("class 4: bounds a huge traceback tail and marks the elision", async () => {
    const frames = Array.from(
      { length: 600 },
      (_, i) => `  File "/app/depth.py", line ${i}, in recurse\n    recurse()\n`,
    ).join("");
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: `Traceback (most recent call last):\n${frames}RecursionError: maximum recursion depth exceeded\n`,
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toContain("[... earlier output elided ...]");
    expect(result.errorMessage).toContain("RecursionError: maximum recursion depth exceeded");
    expect(result.errorMessage!.length).toBeLessThan(4 * 1024 + 200);
  });
});
