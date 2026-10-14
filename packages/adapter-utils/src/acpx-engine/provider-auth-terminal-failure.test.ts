import { describe, expect, it } from "vitest";
import {
  ACPX_AUTH_REQUIRED_ERROR_CODE,
  classifyProviderAuthTerminalSessionFailure,
} from "./terminal-session-failure.js";

describe("classifyProviderAuthTerminalSessionFailure", () => {
  it.each([
    {
      category: "access",
      title: "Failed to authenticate. API Error: 401 OAuth access token has expired",
      details: "request_id=req_auth_1",
    },
    {
      category: "access",
      title: "ACP agent reported a terminal access failure.",
      details: "Failed to authenticate. API Error: 401 Invalid bearer token",
    },
    {
      category: "service",
      title: "oauth2: invalid_grant",
      details: "refresh token is no longer valid",
    },
    {
      category: "request",
      title: "Request rejected",
      details: '{"error":"authentication_failed","api_error_status":401}',
    },
  ])("classifies %j as terminal auth-required", (failure) => {
    expect(classifyProviderAuthTerminalSessionFailure(failure)).toEqual({
      errorCode: ACPX_AUTH_REQUIRED_ERROR_CODE,
    });
    expect(ACPX_AUTH_REQUIRED_ERROR_CODE).toBe("acpx_auth_required");
  });

  it.each([
    {
      category: "limit",
      title: "You've hit your usage limit for GPT-5.",
      details: "Try again at 4:30 PM (America/Chicago).",
    },
    {
      category: "service",
      title: "HTTP 529: overloaded_error",
      details: "Service unavailable",
    },
    {
      category: "access",
      title: "Please run the provider login command to authenticate.",
      details: null,
    },
    {
      category: "access",
      title: "Parsed 401 rows from the fixture",
      details: null,
    },
  ])("does not classify %j as a provider rejection", (failure) => {
    expect(classifyProviderAuthTerminalSessionFailure(failure)).toBeNull();
  });

  it("ignores empty surfaces", () => {
    expect(classifyProviderAuthTerminalSessionFailure({ category: "unknown" })).toBeNull();
    expect(
      classifyProviderAuthTerminalSessionFailure({ category: "access", title: "", details: "  " }),
    ).toBeNull();
  });
});
