import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  classifyRunTimeoutErrorReason,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});

describe("classifyRunTimeoutErrorReason (TOP-396)", () => {
  it("classifies a timed_out settle using the effective timeout budget", () => {
    expect(
      classifyRunTimeoutErrorReason({
        outcome: "timed_out",
        timeoutFired: true,
        effectiveTimeoutSec: 180,
      }),
    ).toBe("timed out after 180s (run budget exceeded)");
  });

  it("classifies an errorCode=timeout settle even when the outcome is failed", () => {
    expect(
      classifyRunTimeoutErrorReason({
        outcome: "failed",
        errorCode: "timeout",
        timeoutFired: false,
        effectiveTimeoutSec: 45,
      }),
    ).toBe("timed out after 45s (run budget exceeded)");
  });

  it("classifies from resultJson timeoutFired alone", () => {
    expect(
      classifyRunTimeoutErrorReason({
        outcome: "failed",
        timeoutFired: true,
        effectiveTimeoutSec: 60,
      }),
    ).toBe("timed out after 60s (run budget exceeded)");
  });

  it("degrades gracefully when no timeout duration is known", () => {
    expect(classifyRunTimeoutErrorReason({ outcome: "timed_out" })).toBe(
      "timed out (run budget exceeded)",
    );
    expect(
      classifyRunTimeoutErrorReason({
        outcome: "timed_out",
        effectiveTimeoutSec: 0,
      }),
    ).toBe("timed out (run budget exceeded)");
  });

  it("returns null for non-timeout settlements so real crash errors survive", () => {
    expect(
      classifyRunTimeoutErrorReason({
        outcome: "failed",
        errorCode: "adapter_failed",
        timeoutFired: false,
        effectiveTimeoutSec: 180,
      }),
    ).toBeNull();
    expect(classifyRunTimeoutErrorReason({ outcome: "succeeded" })).toBeNull();
    expect(classifyRunTimeoutErrorReason({ outcome: "cancelled" })).toBeNull();
    expect(
      classifyRunTimeoutErrorReason({ outcome: "interrupted" }),
    ).toBeNull();
  });
});
