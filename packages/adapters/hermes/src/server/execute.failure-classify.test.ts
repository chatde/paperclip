/**
 * TOP-684: fail-fast classification + error surfacing in the hermes-local
 * adapter execute path.
 *
 * Contract under test:
 * - A provider quota failure (the CLI's `API call failed ... HTTP 429` line on
 *   stdout) sets errorCode/errorFamily to the provider_quota bucket instead of
 *   falling through to the generic "Hermes exited with code 1" adapter_failed.
 * - A transient upstream overload sets the transient_upstream bucket.
 * - A setup fatal surfaces its real reason (not the generic message) but keeps
 *   the default adapter_failed treatment.
 * - A successful run is never assigned a failure errorCode/errorFamily.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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
    runId: "test-run-failure-classify",
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

describe("hermes-local adapter failure classification + surfacing (TOP-684)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a provider quota failure to the provider_quota bucket", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout:
        "API call failed after 3 retries: HTTP 429: Error code: 429 - {'status': 429, 'title': 'Too Many Requests'}\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("HTTP 429");
  });

  it("routes a transient upstream overload to the transient_upstream bucket", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "API call failed after 3 retries: Service temporarily overloaded\n",
    });
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("Service temporarily overloaded");
  });

  it("surfaces a setup fatal's real reason but keeps default (no crash) classification", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "✗ --worktree requires being inside a git repository.\n",
    });
    const result = await execute(makeCtx());
    // Surfaced the real cause, not the generic exit-code message.
    expect(result.errorMessage).toContain("--worktree requires being inside a git");
    expect(result.errorMessage).not.toBe("Hermes exited with code 1");
    // Not quota/transient, so it keeps the default adapter_failed treatment.
    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
  });

  it("does not assign a failure bucket to a successful run that retried mid-run", async () => {
    mockChild({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout:
        "API call failed after 1 retries: HTTP 429: Too Many Requests\nAll done.\nsession_id: abc123\n",
    });
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
  });

  it("keeps the generic message only when there is no recoverable reason", async () => {
    mockChild({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });
    const result = await execute(makeCtx());
    expect(result.errorMessage).toBe("Hermes exited with code 1");
    expect(result.errorCode).toBeUndefined();
  });
});
