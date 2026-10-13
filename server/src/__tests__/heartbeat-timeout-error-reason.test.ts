/**
 * TOP-396: timeout errorReason classification — end-to-end through the real
 * heartbeat run settle path.
 *
 * Acceptance (TOP-177 symptom 3):
 * - A deliberately timed-out run shows a classified reason (contains
 *   "timed out") on the agent row (what GET /api/companies/{cid}/agents
 *   serves), not "Traceback (most recent call last):".
 * - A deliberately crashing run still shows its real error line.
 * - No behaviour change to run status/errorCode itself.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

// Simulates the pre-fix hermes adapter on a timeout: the child process is
// killed by SIGINT and its KeyboardInterrupt traceback contributes exactly
// one matching stderr line — the bare traceback header — which the adapter
// used to pass through as errorMessage even though timedOut was true.
const TIMEOUT_LEAK_ADAPTER = "timeout_reason_leak_test";
// A run settled as failed with errorCode=timeout (run-budget path that does
// not flip adapterResult.timedOut).
const TIMEOUT_ERRORCODE_ADAPTER = "timeout_reason_errorcode_test";
// A genuine non-timeout crash with a real exception line.
const CRASH_ADAPTER = "timeout_reason_crash_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timeout-error-reason tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("timeout errorReason classification (TOP-396)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workspaceCwd!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-timeout-reason-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    workspaceCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-timeout-reason-"),
    );
    registerServerAdapter({
      type: TIMEOUT_LEAK_ADAPTER,
      execute: async () => ({
        exitCode: null,
        signal: "SIGINT",
        timedOut: true,
        errorMessage: "Traceback (most recent call last):",
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: TIMEOUT_LEAK_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: TIMEOUT_ERRORCODE_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "timeout",
        errorMessage: "Traceback (most recent call last):",
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: TIMEOUT_ERRORCODE_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: CRASH_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ValueError: boom",
        resultJson: {},
      }),
      testEnvironment: async () => ({
        adapterType: CRASH_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupFixture();
  });

  afterAll(async () => {
    unregisterServerAdapter(TIMEOUT_LEAK_ADAPTER);
    unregisterServerAdapter(TIMEOUT_ERRORCODE_ADAPTER);
    unregisterServerAdapter(CRASH_ADAPTER);
    if (workspaceCwd) await fs.rm(workspaceCwd, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function cleanupFixture() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function seedFixture(input: {
    adapterType: string;
    adapterConfig: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Timeout Reason Project",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: workspaceCwd,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimeoutReasonCoder",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Timeout reason issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      projectId,
      projectWorkspaceId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function waitForRunToLeaveActiveStates(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function waitForAgent(agentId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
    while (Date.now() < deadline && row?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
    }
    return row;
  }

  it("stores a classified reason for a timed-out run, never the raw traceback head", async () => {
    const fixture = await seedFixture({
      adapterType: TIMEOUT_LEAK_ADAPTER,
      adapterConfig: { timeoutSec: 180 },
    });
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    // No behaviour change to run status/errorCode itself.
    expect(finishedRun?.status).toBe("timed_out");
    expect(finishedRun?.errorCode).toBe("timeout");
    // The stored reason is classified — no traceback text anywhere.
    expect(finishedRun?.error).toBe("timed out after 180s (run budget exceeded)");

    const agent = await waitForAgent(fixture.agentId);
    expect(agent?.errorReason).toBe("timed out after 180s (run budget exceeded)");
    expect(agent?.errorReason).not.toContain("Traceback");
    expect(agent?.errorReason).toContain("timed out");
  });

  it("stores a classified reason when the run settles failed with errorCode=timeout", async () => {
    const fixture = await seedFixture({
      adapterType: TIMEOUT_ERRORCODE_ADAPTER,
      adapterConfig: { timeoutSec: 45 },
    });
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.errorCode).toBe("timeout");
    expect(finishedRun?.error).toBe("timed out after 45s (run budget exceeded)");

    const agent = await waitForAgent(fixture.agentId);
    expect(agent?.errorReason).toBe("timed out after 45s (run budget exceeded)");
    expect(agent?.errorReason).not.toContain("Traceback");
  });

  it("keeps the real error line for a genuine non-timeout crash", async () => {
    const fixture = await seedFixture({
      adapterType: CRASH_ADAPTER,
      adapterConfig: { timeoutSec: 180 },
    });
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { issueId: fixture.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(run).not.toBeNull();

    const finishedRun = await waitForRunToLeaveActiveStates(run!.id);
    expect(finishedRun?.status).toBe("failed");
    expect(finishedRun?.error).toBe("ValueError: boom");

    const agent = await waitForAgent(fixture.agentId);
    expect(agent?.errorReason).toBe("ValueError: boom");
  });
});
