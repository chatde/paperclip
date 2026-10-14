import { describe, expect, it } from "vitest";
import { isProviderAuthRejectionText } from "./provider-auth-rejection.js";

describe("isProviderAuthRejectionText", () => {
  it.each([
    "ACP agent reported a terminal access failure.\nFailed to authenticate. API Error: 401 OAuth access token has expired",
    "Failed to authenticate. API Error: 401 Invalid bearer token",
    "oauth2: \"invalid_grant\" and refresh token is no longer valid",
    "error: invalid_grant",
    '{"error":"authentication_failed","api_error_status":401}',
    "Failed to authenticate. Your OAuth access token is expired.",
    "The refresh token has already been used",
    "The refresh token has been revoked",
    "Request failed: HTTP status 401 (unauthorized) for the configured credential",
  ])("recognizes the provider rejection surface %j", (text) => {
    expect(isProviderAuthRejectionText(text)).toBe(true);
  });

  it.each([
    "",
    "Please run `claude login` to authenticate.",
    "The sandbox duplex control channel was lost (other) before the run completed.",
    "ACP agent reported a terminal limit failure.\nYou've hit your usage limit for GPT-5. Try again at 4:30 PM.",
    "Sandbox provider \"kubernetes\" is not installed or its plugin worker is not running.",
    "Maximum turns reached",
    // A bare 401 with no auth vocabulary is not a credential rejection.
    "Parsed 401 rows from the fixture",
  ])("does not classify %j as a provider rejection", (text) => {
    expect(isProviderAuthRejectionText(text)).toBe(false);
  });

  it("rejects non-string surfaces", () => {
    expect(isProviderAuthRejectionText(null)).toBe(false);
    expect(isProviderAuthRejectionText(undefined)).toBe(false);
    expect(isProviderAuthRejectionText(401)).toBe(false);
  });
});
