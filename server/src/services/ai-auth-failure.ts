import { AI_PROVIDERS, isAiConnectionCompatible, isProviderAuthRejectionText, type AiConnectionBinding } from "@paperclipai/shared";

/** Provider authentication signals only. Tool authorization and quotas need different repairs. */
export function isAiAuthenticationFailure(code: string | null | undefined): boolean {
  return Boolean(code && (
    /^(acpx|claude|codex|grok|opencode|gemini|kimi|pi|cursor)_auth_required$/.test(code)
    || ["adapter_auth_missing", "authentication_required", "auth_required", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"].includes(code)
  ));
}

/** Only a persisted blocked classification confirms that an inline repair owns recovery. */
export function isAiAuthenticationBlocked(run: { errorCode?: string | null; livenessState?: string | null } | null | undefined): boolean {
  return run?.livenessState === "blocked" && isAiAuthenticationFailure(run.errorCode);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* a non-JSON surface carries no structured evidence */
    }
  }
  return {};
}

/**
 * A terminal provider auth rejection: the provider refused the credential the
 * seat is holding (the 401 / invalid_grant class, plus the typed Codex
 * refresh-token rejection codes). Re-running with the same credential
 * reproduces the identical failure, so every retry lane must treat such a run
 * as terminal and the human re-auth repair path owns recovery. A generic
 * auth-required surface (for example a missing login) is deliberately not
 * terminal here: it keeps the existing bounded-recovery behavior.
 */
export function isTerminalProviderAuthRejection(
  run: {
    error?: string | null;
    errorCode?: string | null;
    resultJson?: unknown;
  } | null | undefined,
): boolean {
  if (!run) return false;
  const resultJson = readRecord(run.resultJson);
  const terminal = readRecord(resultJson.terminalSessionFailure);
  // The rejection must ride an auth surface: an auth error code from the
  // adapter classification, or an ACP `access` terminal failure (the shape the
  // runs carried before terminal classification existed).
  const authSurface =
    isAiAuthenticationFailure(run.errorCode) || terminal.category === "access";
  if (!authSurface) return false;
  // The typed refresh-token rejection codes assert a refused credential on
  // their own; their provider wording varies by CLI version.
  if (typeof run.errorCode === "string" && /^refresh_token_/.test(run.errorCode)) {
    return true;
  }
  return [
    run.error,
    resultJson.errorMessage,
    resultJson.stopReason,
    terminal.title,
    terminal.details,
  ].some(isProviderAuthRejectionText);
}

export function aiBindingForAuthRecovery(
  adapterType: string,
  config: Record<string, unknown>,
): AiConnectionBinding | undefined {
  for (const provider of AI_PROVIDERS) {
    const binding = { provider, method: provider === "openrouter" ? "api_key" : "subscription", mode: "responsible_user" } as const;
    if (isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent)) return binding;
  }
  return undefined;
}
