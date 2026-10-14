/**
 * Definite provider authentication rejections — the 401 / invalid_grant class.
 *
 * A rejection means the provider refused the credential the seat is currently
 * holding (expired OAuth access token, revoked refresh token, invalid bearer
 * token, HTTP 401). Re-running with the same credential produces the identical
 * failure every time, so the condition is terminal until a human re-authenticates
 * the seat. This differs from a generic "authentication required" / "please log
 * in" surface, which is a missing-credential setup state whose repair can still
 * be discovered by a bounded recovery.
 *
 * The matcher is shared by the ACP execution engine (which classifies terminal
 * session failures in memory) and the control-plane retry scheduler (which must
 * not schedule successor retry runs for a rejected credential). Keep it strict:
 * a false positive turns a recoverable failure into a stranded issue, so only
 * unambiguous provider rejection wording qualifies.
 */

/** Unambiguous provider rejection wording, sufficient on its own. */
const DEFINITE_AUTH_REJECTION_RE =
  /\binvalid[\s_-]?grant\b|failed to authenticate|authentication[\s_-]?failed|\binvalid bearer token\b|(?:oauth\s+)?access[\s_-]?token (?:is |has )?(?:expired|invalid(?:ated)?|revoked)|refresh token (?:has )?(?:expired|been (?:invalidated|revoked)|already been used)/i;

/** An HTTP 401 only counts near auth vocabulary; "401" alone is not evidence. */
const HTTP_401_RE = /\b401\b/;
const AUTH_CONTEXT_RE = /auth|token|credential|unauthorized|bearer|oauth|login/i;

/**
 * Returns true when `text` carries a definite provider authentication
 * rejection (401 / invalid_grant class). Callers usually gate this on a
 * broader failure surface (auth error code or an ACP `access` terminal
 * failure) so unrelated text that merely mentions "401" cannot classify.
 */
export function isProviderAuthRejectionText(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    DEFINITE_AUTH_REJECTION_RE.test(text) ||
    (HTTP_401_RE.test(text) && AUTH_CONTEXT_RE.test(text))
  );
}
