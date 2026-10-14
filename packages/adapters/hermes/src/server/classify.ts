/**
 * Failure-cause extraction and fail-fast classification for the hermes-local
 * adapter (TOP-684).
 *
 * The hermes CLI writes its own terminal failure line to *stdout* (for example
 * `API call failed after 3 retries: HTTP 429 ...` or
 * `✗ --worktree requires being inside a git repository.`), not to stderr.
 * `parseHermesOutput` only scans stderr for error lines, so these runs produced
 * no `errorMessage` and fell through to the generic "Hermes exited with code 1",
 * where every one was counted as `adapter_failed`.
 *
 * This module recovers the real cause from the combined stream and classifies
 * provider quota and transient upstream failures into their own recovery buckets
 * (`provider_quota` / `transient_upstream`) so they are not miscounted as adapter
 * crashes. The observed 2026-10-12 failures were dominated by these two buckets
 * (HTTP 429 / resource-exhausted quota and HTTP 503 / "temporarily overloaded"
 * upstream), plus a tail of setup-fatals (non-git `--worktree`) that mainly need
 * surfacing.
 */

export interface HermesFailureClassification {
  errorCode: "provider_quota" | "hermes_transient_upstream";
  errorFamily: "provider_quota" | "transient_upstream";
}

/**
 * The hermes CLI's own terminal API-call failure line. Anchored at line start so
 * agent output that merely quotes such a line mid-sentence is not treated as the
 * run's own failure.
 */
const API_CALL_FAILED_RE = /^\s*API call failed after \d+ retries?:?\s*(.*)$/i;

/**
 * Fatal setup lines the hermes CLI emits before/around the model call (for
 * example `--worktree requires being inside a git repository.` or
 * `Cannot start without the required Paperclip-managed skills: ...`). Anchored to
 * the CLI's markers to avoid matching agent prose.
 */
const SETUP_FATAL_RE = /^\s*(?:✗\s+\S.*|Cannot start (?:without|inside)\b.*)$/;

/**
 * Provider quota / rate-limit signatures. Checked before transient so a message
 * like "HTTP 429: Too Many Requests ... try again later" resolves to quota.
 */
const QUOTA_RE =
  /\b(?:429|resource[_\s-]?exhausted)\b|too many requests|rate[-\s]?limit|quota|usage limit|(?:daily|model)\s+limit|exceeded your current quota|limit reached/i;

/**
 * Transient upstream / capacity signatures (5xx overload, high demand).
 */
const TRANSIENT_RE =
  /\b(?:502|503|504)\b|service (?:temporarily )?(?:unavailable|overloaded)|temporarily overloaded|overloaded|high demand|try again later|service unavailable|\bat capacity\b|capacity limit/i;

/**
 * Extract the hermes CLI's terminal failure reason from the combined output.
 *
 * Prefers the last `API call failed ... : <reason>` line (carries the provider
 * detail), falling back to the last fatal setup line. Returns null when the CLI
 * reported no recognizable terminal failure (genuine crash / clean exit).
 */
export function extractHermesFailureReason(
  stdout: string,
  stderr: string,
): string | null {
  const lines = `${stdout ?? ""}\n${stderr ?? ""}`.split(/\r?\n/);
  let apiReason: string | null = null;
  let setupFatal: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const api = line.match(API_CALL_FAILED_RE);
    if (api) {
      const reason = (api[1] ?? "").trim();
      // Keep the last API failure reason (the terminal one), but never record an
      // empty reason as the sole cause.
      apiReason = reason.length > 0 ? reason : "API call failed";
      continue;
    }
    if (SETUP_FATAL_RE.test(line)) {
      setupFatal = line;
    }
  }
  return apiReason ?? setupFatal;
}

/**
 * Classify a failure reason into a recovery bucket. Returns null for causes that
 * should keep the default `adapter_failed` treatment (real crashes, setup
 * fatals, tool errors).
 */
export function classifyHermesFailure(
  reason: string | null | undefined,
): HermesFailureClassification | null {
  if (!reason) return null;
  if (QUOTA_RE.test(reason)) {
    return { errorCode: "provider_quota", errorFamily: "provider_quota" };
  }
  if (TRANSIENT_RE.test(reason)) {
    return {
      errorCode: "hermes_transient_upstream",
      errorFamily: "transient_upstream",
    };
  }
  return null;
}
