type RetryRun = {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

/** Server-owned counts for one automatic continuation chain. Repair slots live
 * in legacyDispositionEpisode and are never charged to either counter here. */
export interface ExecutionRetryAccounting {
  version: 1;
  failureRetries: number;
  maxTurnContinuations: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function savedAccounting(run: RetryRun): ExecutionRetryAccounting | null {
  const value = run.contextSnapshot?.executionRetryAccounting;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const failureRetries = count(saved.failureRetries);
  const maxTurnContinuations = count(saved.maxTurnContinuations);
  if (saved.version !== 1 || failureRetries === null || maxTurnContinuations === null) return null;
  return { version: 1, failureRetries, maxTurnContinuations };
}

function historicalFailureCount(run: RetryRun): number {
  if (run.scheduledRetryReason === "max_turns_continuation" || run.scheduledRetryReason === "issue_disposition_repair") return 0;
  if (run.scheduledRetryReason === "ai_connection_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeAiConnectionWait);
    if (saved !== null) return saved;
  }
  if (run.scheduledRetryReason === "workspace_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeWorkspaceWait);
    if (saved !== null) return saved;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return count(run.scheduledRetryAttempt) ?? 0;
}

export function executionRetryAccounting(run: RetryRun): ExecutionRetryAccounting {
  const saved = savedAccounting(run);
  const nonFailureLane = ["max_turns_continuation", "issue_disposition_repair", "workspace_busy", "ai_connection_busy"].includes(run.scheduledRetryReason ?? "");
  return {
    version: 1,
    failureRetries: Math.max(saved?.failureRetries ?? 0, saved && nonFailureLane ? 0 : historicalFailureCount(run)),
    maxTurnContinuations: Math.max(saved?.maxTurnContinuations ?? 0,
      run.scheduledRetryReason === "max_turns_continuation" ? count(run.scheduledRetryAttempt) ?? 0 : 0),
  };
}

/** Resource waits, repairs and productive continuations do not spend failures. */
export function executionFailureRetryCount(run: RetryRun): number {
  return executionRetryAccounting(run).failureRetries;
}

export function executionRetryAttemptCount(run: RetryRun, reason: string): number {
  if (reason === "workspace_busy" || reason === "ai_connection_busy") {
    return run.scheduledRetryReason === reason ? count(run.scheduledRetryAttempt) ?? 0 : 0;
  }
  const accounting = executionRetryAccounting(run);
  return reason === "max_turns_continuation" ? accounting.maxTurnContinuations : accounting.failureRetries;
}

export function accountingForScheduledRetry(run: RetryRun, reason: string, attempt: number): ExecutionRetryAccounting {
  const accounting = executionRetryAccounting(run);
  if (reason === "max_turns_continuation") accounting.maxTurnContinuations = attempt;
  else if (reason !== "workspace_busy" && reason !== "ai_connection_busy") accounting.failureRetries = attempt;
  return accounting;
}

// ---------------------------------------------------------------------------
// Identical-failure chain (TOP-596)
// ---------------------------------------------------------------------------

/** Consecutive identical failures after which an automatic retry is terminal. */
export const IDENTICAL_FAILURE_TERMINAL_COUNT = 2;

/**
 * Normalized signature of a run failure (TOP-596). Digit runs collapse to
 * "#", so volatile detail (retry countdowns, line numbers, ids) does not
 * split the chain, while genuinely different failures keep different
 * signatures. The tail is kept because that is where the diagnosable reason
 * lives; the head is where the stable error family lives. Null when the run
 * carried no error at all.
 */
export function failureSignature(error: unknown, errorCode: unknown): string | null {
  const code =
    typeof errorCode === "string" && errorCode.trim() ? errorCode.trim() : null;
  const text = typeof error === "string" ? error : "";
  const normalized = text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  const tail = normalized.slice(-512);
  if (!code && !tail) return null;
  return JSON.stringify([code, tail]);
}

export interface IdenticalFailureChain {
  version: 1;
  signature: string;
  /** Consecutive identical failures ending at the stamped run. */
  chainCount: number;
}

export function readIdenticalFailureChain(value: unknown): IdenticalFailureChain | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const signature = saved.signature;
  const chainCount = saved.chainCount;
  if (
    saved.version !== 1 ||
    typeof signature !== "string" ||
    !signature ||
    !(typeof chainCount === "number" && Number.isSafeInteger(chainCount) && chainCount >= 1)
  ) {
    return null;
  }
  return { version: 1, signature, chainCount };
}

/**
 * Extend the identical-failure chain with the current run's signature: the
 * chain grows only while consecutive runs fail identically; any new signature
 * restarts it at 1. Returns null when the run carried no signature.
 */
export function extendIdenticalFailureChain(
  previous: IdenticalFailureChain | null,
  signature: string | null,
): IdenticalFailureChain | null {
  if (!signature) return null;
  return {
    version: 1,
    signature,
    chainCount:
      previous && previous.signature === signature ? previous.chainCount + 1 : 1,
  };
}
