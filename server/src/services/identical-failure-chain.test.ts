import { describe, expect, it } from "vitest";

import {
  failureSignature,
  readIdenticalFailureChain,
  extendIdenticalFailureChain,
  IDENTICAL_FAILURE_TERMINAL_COUNT,
} from "./execution-recovery-attempt.js";

describe("failureSignature (TOP-596)", () => {
  it("returns null when the run carried no error at all", () => {
    expect(failureSignature(null, null)).toBeNull();
    expect(failureSignature("", undefined)).toBeNull();
    expect(failureSignature("   ", null)).toBeNull();
  });

  it("normalizes volatile digits so the same failure keeps one signature", () => {
    const a = failureSignature(
      "Hermes exited with code 1\n--- stdout tail ---\nAPI call failed after 3 retries: HTTP 429: quota exceeded. Please retry in 32.444976942s",
      "adapter_failed",
    );
    const b = failureSignature(
      "Hermes exited with code 1\n--- stdout tail ---\nAPI call failed after 3 retries: HTTP 429: quota exceeded. Please retry in 47.1s",
      "adapter_failed",
    );
    expect(a).toBe(b);
  });

  it("keeps genuinely different failures on different signatures", () => {
    const quota = failureSignature(
      "Hermes exited with code 1\n--- stdout tail ---\nHTTP 429: RESOURCE_EXHAUSTED: quota",
      "adapter_failed",
    );
    const crash = failureSignature(
      "Traceback (most recent call last):\nKeyboardInterrupt",
      "adapter_failed",
    );
    expect(quota).not.toBe(crash);
  });

  it("keys on the tail where the diagnosable reason lives", () => {
    const head = "Hermes exited with code 1\n";
    const a = failureSignature(`${head}--- stdout tail ---\nValueError: boom`, "adapter_failed");
    const b = failureSignature(`${head}--- stdout tail ---\nKeyError: nope`, "adapter_failed");
    expect(a).not.toBe(b);
  });

  it("differs across errorCodes even with identical text", () => {
    expect(failureSignature("boom", "adapter_failed")).not.toBe(
      failureSignature("boom", "provider_quota"),
    );
  });
});

describe("identical-failure chain (TOP-596)", () => {
  it("starts a chain at 1 and grows only on identical consecutive signatures", () => {
    const sig = failureSignature("Hermes exited with code 1", "adapter_failed");
    const first = extendIdenticalFailureChain(null, sig);
    expect(first).toEqual({ version: 1, signature: sig, chainCount: 1 });
    const second = extendIdenticalFailureChain(first, sig);
    expect(second).toEqual({ version: 1, signature: sig, chainCount: 2 });
    const third = extendIdenticalFailureChain(second, sig);
    expect(third!.chainCount).toBe(3);
  });

  it("restarts the chain when the failure signature changes", () => {
    const sigA = failureSignature("ValueError: boom", "adapter_failed");
    const sigB = failureSignature("KeyError: nope", "adapter_failed");
    const chain = extendIdenticalFailureChain(
      extendIdenticalFailureChain(null, sigA),
      sigB,
    );
    expect(chain).toEqual({ version: 1, signature: sigB, chainCount: 1 });
  });

  it("returns null without a signature", () => {
    expect(extendIdenticalFailureChain(null, null)).toBeNull();
  });

  it("round-trips through readIdenticalFailureChain and rejects junk", () => {
    const chain = extendIdenticalFailureChain(null, failureSignature("x", null));
    expect(readIdenticalFailureChain(JSON.parse(JSON.stringify(chain)))).toEqual(chain);
    expect(readIdenticalFailureChain(null)).toBeNull();
    expect(readIdenticalFailureChain("nope")).toBeNull();
    expect(readIdenticalFailureChain({ version: 1, signature: "", chainCount: 1 })).toBeNull();
    expect(readIdenticalFailureChain({ version: 1, signature: "s", chainCount: 0 })).toBeNull();
  });

  it("uses a terminal threshold of 2 identical consecutive failures", () => {
    expect(IDENTICAL_FAILURE_TERMINAL_COUNT).toBe(2);
  });
});
