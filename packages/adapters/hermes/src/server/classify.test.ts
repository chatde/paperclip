/**
 * TOP-684: failure-cause extraction and fail-fast classification for the
 * hermes-local adapter.
 *
 * Contract under test:
 * - The CLI's terminal failure reason is recovered from stdout (where the hermes
 *   CLI actually writes it), not just stderr.
 * - Provider quota (429 / resource-exhausted) and transient upstream (503 /
 *   overload) causes are classified into their own recovery buckets so they are
 *   not miscounted as adapter_failed.
 * - Real crashes / setup fatals are left to the default adapter_failed treatment
 *   (classification returns null) but still get their real reason surfaced.
 */

import { describe, expect, it } from "vitest";

import {
  extractHermesFailureReason,
  classifyHermesFailure,
} from "./classify.js";

describe("extractHermesFailureReason", () => {
  it("recovers the provider reason from an API-call failure on stdout", () => {
    const stdout = [
      "[hermes] Starting Hermes Agent (model=x, provider=y, timeout=900s)",
      "API call failed after 3 retries: HTTP 429: Error code: 429 - {'status': 429, 'title': 'Too Many Requests'}",
    ].join("\n");
    expect(extractHermesFailureReason(stdout, "")).toBe(
      "HTTP 429: Error code: 429 - {'status': 429, 'title': 'Too Many Requests'}",
    );
  });

  it("keeps the last API-call failure reason (the terminal one)", () => {
    const stdout = [
      "API call failed after 3 retries: transient blip",
      "API call failed after 3 retries: Service temporarily overloaded",
    ].join("\n");
    expect(extractHermesFailureReason(stdout, "")).toBe(
      "Service temporarily overloaded",
    );
  });

  it("recovers a fatal setup line when there is no API-call failure", () => {
    const stdout = [
      "[hermes] Starting Hermes Agent",
      "✗ --worktree requires being inside a git repository.",
    ].join("\n");
    expect(extractHermesFailureReason(stdout, "")).toBe(
      "✗ --worktree requires being inside a git repository.",
    );
  });

  it("does not treat agent prose that quotes a failure mid-sentence as the run cause", () => {
    const stdout = "I saw a log that said API call failed after 3 retries: HTTP 429 earlier.";
    expect(extractHermesFailureReason(stdout, "")).toBeNull();
  });

  it("returns null for a clean crash with no CLI terminal failure line", () => {
    const stderr = ["Traceback (most recent call last):", "ValueError: boom"].join("\n");
    expect(extractHermesFailureReason("", stderr)).toBeNull();
  });
});

describe("classifyHermesFailure", () => {
  it("classifies HTTP 429 / rate-limit / quota as provider_quota", () => {
    for (const reason of [
      "HTTP 429: Error code: 429 - {'status': 429, 'title': 'Too Many Requests'}",
      "Too Many Requests",
      "RESOURCE_EXHAUSTED: quota exceeded",
      "You have exceeded your current quota",
      "rate limit reached",
    ]) {
      expect(classifyHermesFailure(reason)).toEqual({
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
      });
    }
  });

  it("classifies 503 / overload / high demand as transient upstream", () => {
    for (const reason of [
      "HTTP 503: Gemini HTTP 503 (UNAVAILABLE): This model is currently experiencing high demand.",
      "Service temporarily overloaded",
      "server overloaded",
      "service unavailable",
    ]) {
      expect(classifyHermesFailure(reason)).toEqual({
        errorCode: "hermes_transient_upstream",
        errorFamily: "transient_upstream",
      });
    }
  });

  it("prefers quota when a message mentions both quota and retrying later", () => {
    expect(
      classifyHermesFailure("HTTP 429: Too Many Requests, please try again later"),
    ).toEqual({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  });

  it("leaves real crashes and setup fatals unclassified", () => {
    expect(classifyHermesFailure("ValueError: boom")).toBeNull();
    expect(
      classifyHermesFailure("✗ --worktree requires being inside a git repository."),
    ).toBeNull();
    expect(classifyHermesFailure(null)).toBeNull();
    expect(classifyHermesFailure("")).toBeNull();
  });
});
