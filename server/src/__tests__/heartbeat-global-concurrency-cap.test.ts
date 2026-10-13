import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueComments,
  issueRelations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  parseGlobalClaimFairnessDisabled,
  parseGlobalMaxConcurrentRuns,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Optional gate so a test can hold a claimed run inside the adapter while it
// asserts the admission state of the other queued runs (dispatch is
// fire-and-forget, so without the gate the finalize race would be flaky).
let adapterGate: Promise<void> | null = null;
// Resolver for the currently held adapter gate (set alongside adapterGate).
let releaseHeldRun: () => void = () => {};

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    await adapterGate;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Global concurrency cap test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global concurrency cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("parseGlobalMaxConcurrentRuns", () => {
  it("disables the cap for unset, empty, zero, and invalid values", () => {
    expect(parseGlobalMaxConcurrentRuns(undefined)).toBeNull();
    expect(parseGlobalMaxConcurrentRuns(null)).toBeNull();
    expect(parseGlobalMaxConcurrentRuns("")).toBeNull();
    expect(parseGlobalMaxConcurrentRuns("0")).toBeNull();
    expect(parseGlobalMaxConcurrentRuns("-3")).toBeNull();
    expect(parseGlobalMaxConcurrentRuns("unlimited")).toBeNull();
    expect(parseGlobalMaxConcurrentRuns("2.5")).toBe(2);
    expect(parseGlobalMaxConcurrentRuns("6")).toBe(6);
    expect(parseGlobalMaxConcurrentRuns(6)).toBe(6);
  });
});

describe("parseGlobalClaimFairnessDisabled", () => {
  it("keeps fairness enabled unless the kill switch is explicitly set", () => {
    expect(parseGlobalClaimFairnessDisabled(undefined)).toBe(false);
    expect(parseGlobalClaimFairnessDisabled(null)).toBe(false);
    expect(parseGlobalClaimFairnessDisabled("")).toBe(false);
    expect(parseGlobalClaimFairnessDisabled("on")).toBe(false);
    expect(parseGlobalClaimFairnessDisabled("1")).toBe(false);
    expect(parseGlobalClaimFairnessDisabled("off")).toBe(true);
    expect(parseGlobalClaimFairnessDisabled("OFF")).toBe(true);
    expect(parseGlobalClaimFairnessDisabled(" false ")).toBe(true);
    expect(parseGlobalClaimFairnessDisabled("0")).toBe(true);
    expect(parseGlobalClaimFairnessDisabled("disabled")).toBe(true);
    expect(parseGlobalClaimFairnessDisabled(0)).toBe(true);
  });
});

describeEmbeddedPostgres("heartbeat global concurrency cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-global-concurrency-cap-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS: "1" },
    });
  }, 20_000);

  afterEach(async () => {
    adapterGate = null;
    releaseHeldRun();
    releaseHeldRun = () => {};
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Executed runs write to many company-scoped tables; clear them all.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(companyId: string, name: string, adapterType = "codex_local") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          // Per-agent headroom exists; only the fleet-wide cap can defer these.
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    return agentId;
  }

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Global Cap Co",
      status: "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertRun(
    companyId: string,
    agentId: string,
    status: "queued" | "running",
    ageMs = 60_000,
    issueId?: string,
  ) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: status === "queued" ? "queued" : "claimed",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status,
      wakeupRequestId,
      ...(issueId ? { contextSnapshot: { issueId } } : {}),
      ...(status === "running" ? { processPid: process.pid } : {}),
      createdAt: new Date(Date.now() - ageMs),
    });
    return runId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`)
      .then((rows) => rows[0] ?? null);
  }

  it("defers queued runs instance-wide while the fleet-wide cap is reached", async () => {
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Cap Agent A");
    const agentB = await insertAgent(companyId, "Cap Agent B");
    const runningRunId = await insertRun(companyId, agentA, "running");
    const queuedA = await insertRun(companyId, agentA, "queued");
    const queuedB = await insertRun(companyId, agentB, "queued");

    await heartbeat.resumeQueuedRuns();

    // The single fleet-wide slot is held by runningRunId: both queued runs wait.
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await runStatus(runningRunId)).toMatchObject({ status: "running" });
    expect(await runStatus(queuedA)).toMatchObject({ status: "queued" });
    expect(await runStatus(queuedB)).toMatchObject({ status: "queued" });
  });

  it("promotes deferred runs one at a time as fleet-wide slots free", async () => {
    let releaseClaimed!: () => void;
    adapterGate = new Promise<void>((resolve) => {
      releaseClaimed = resolve;
    });

    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Promote Agent A");
    const agentB = await insertAgent(companyId, "Promote Agent B");
    const runningRunId = await insertRun(companyId, agentA, "running");
    const queuedA = await insertRun(companyId, agentA, "queued");
    const queuedB = await insertRun(companyId, agentB, "queued");

    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(queuedA)).toMatchObject({ status: "queued" });
    expect(await runStatus(queuedB)).toMatchObject({ status: "queued" });

    // Free the fleet-wide slot.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(sql`${heartbeatRuns.id} = ${runningRunId}`);

    // Exactly one queued run takes the single fleet-wide slot and stays
    // running (held inside the adapter gate) while the other keeps waiting.
    await heartbeat.resumeQueuedRuns();
    const statesAfterPromotion = [await runStatus(queuedA), await runStatus(queuedB)];
    expect(
      statesAfterPromotion.filter((state) => state?.status === "running"),
    ).toHaveLength(1);
    expect(
      statesAfterPromotion.filter((state) => state?.status === "queued"),
    ).toHaveLength(1);
    // Claim is synchronous; the fire-and-forget dispatch reaches the adapter
    // a few awaits later (and then blocks on the gate).
    // Explicit timeout: the claim->adapter dispatch hop is fire-and-forget and
    // can exceed vi.waitFor's 1s default on a cold, loaded run (observed flake,
    // review finding 4).
    await vi.waitFor(
      () => {
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    // Release the claimed run; once it finishes, the next sweep pass (the
    // periodic recovery sweep in production) promotes the rest.
    releaseClaimed();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queuedA)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedB)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });

  it("never defers a process agent (job router) behind the fleet-wide cap", async () => {
    const companyId = await insertCompany();
    const modelAgent = await insertAgent(companyId, "Model Agent");
    const router = await insertAgent(companyId, "Router", "process");
    const otherModelAgent = await insertAgent(companyId, "Other Model Agent");
    await insertRun(companyId, modelAgent, "running");
    const queuedRouter = await insertRun(companyId, router, "queued");
    const queuedModel = await insertRun(companyId, otherModelAgent, "queued");

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    // The single fleet-wide slot is full, yet the process agent runs; the model agent still waits.
    expect(await runStatus(queuedRouter)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedModel)).toMatchObject({ status: "queued" });
  });

  it("never defers the grok_local oversight seat behind the fleet-wide cap", async () => {
    const companyId = await insertCompany();
    const modelAgent = await insertAgent(companyId, "Model Agent");
    const auditor = await insertAgent(companyId, "Chief Audit Officer", "grok_local");
    const otherModelAgent = await insertAgent(companyId, "Other Model Agent");
    await insertRun(companyId, modelAgent, "running");
    const queuedAuditor = await insertRun(companyId, auditor, "queued");
    const queuedModel = await insertRun(companyId, otherModelAgent, "queued");

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(queuedAuditor)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedModel)).toMatchObject({ status: "queued" });
  });

  it("does not defer queued runs when the fleet-wide cap is disabled", async () => {
    const uncapped = heartbeatService(db);
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Uncapped Agent A");
    const agentB = await insertAgent(companyId, "Uncapped Agent B");
    await insertRun(companyId, agentA, "running");
    const queuedA = await insertRun(companyId, agentA, "queued");
    const queuedB = await insertRun(companyId, agentB, "queued");

    await uncapped.resumeQueuedRuns();
    await uncapped.drainActiveRunExecutions();

    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    expect(await runStatus(queuedA)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedB)).toMatchObject({ status: "succeeded" });
  });

  // TOP-387 starvation regression: agent A holds the globally oldest queued
  // run but has no running runs, so it never gets a self-refill. Under the old
  // first-come-first-served claim order, the freed fleet-wide slot was taken
  // within milliseconds by agent B's self-refill (executeRun cleanup ->
  // startNextQueuedRunForAgent(B)) even though B's run was created much later,
  // and A starved across arbitrarily many sweeps.
  it("reserves a freed fleet-wide slot for the oldest cross-agent queued run instead of the finishing run's self-refill", async () => {
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Starved Agent A");
    const agentB = await insertAgent(companyId, "Self-refill Agent B");
    // B holds the single fleet-wide slot via a real claimed run so its
    // completion exercises the production self-refill path.
    adapterGate = new Promise<void>((resolve) => {
      releaseHeldRun = resolve;
    });
    await insertRun(companyId, agentB, "queued");
    await heartbeat.resumeQueuedRuns();
    // Explicit timeout: the claim->adapter dispatch hop is fire-and-forget and
    // can exceed vi.waitFor's 1s default on a cold, loaded run (observed flake,
    // review finding 4).
    await vi.waitFor(
      () => {
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    // Backlog accumulates while B runs: A's run is strictly older than B's
    // second run, and A has no running runs to self-refill from.
    const queuedOldA = await insertRun(companyId, agentA, "queued", 3_600_000);
    const queuedNewB = await insertRun(companyId, agentB, "queued", 60_000);

    // Finish B's held run; its cleanup self-refills agent B, the exact race
    // that starved A in production. Later runs are not gated.
    adapterGate = null;
    releaseHeldRun();
    await heartbeat.drainActiveRunExecutions();

    // Fairness: the freed slot was NOT handed to B's newer run during the
    // self-refill; both stay queued, reserved for the older run.
    expect(await runStatus(queuedNewB)).toMatchObject({ status: "queued" });
    expect(await runStatus(queuedOldA)).toMatchObject({ status: "queued" });

    // Within one scheduler tick the oldest run claims the freed slot; B's
    // newer run keeps waiting behind it.
    adapterGate = new Promise<void>((resolve) => {
      releaseHeldRun = resolve;
    });
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(queuedOldA)).toMatchObject({ status: "running" });
    expect(await runStatus(queuedNewB)).toMatchObject({ status: "queued" });

    adapterGate = null;
    releaseHeldRun();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queuedOldA)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedNewB)).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });

  it.each(["unresolved user", "invalid recovery admission", "unresolved recovery proof"])(
    "does not reserve cap=1 indefinitely for an older run with %s",
    async (rejection) => {
      const companyId = await insertCompany();
      const agentA = await insertAgent(companyId, "Deferred Agent A");
      const agentB = await insertAgent(companyId, "Healthy Agent B");
      let issueId: string | undefined;
      if (rejection !== "unresolved user") {
        issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId, companyId, title: "Deferred recovery", status: "todo",
          assigneeAgentId: agentA, responsibleUserId: "board-user",
        });
      }
      const deferred = await insertRun(companyId, agentA, "queued", 3_600_000, issueId);
      await db.update(agentWakeupRequests).set({
        source: "automation", triggerDetail: "system",
        requestedByActorType: "system", requestedByActorId: null,
        reason: "issue_continuation_needed", payload: {},
      }).where(sql`${agentWakeupRequests.runId} = ${deferred}`);
      await db.update(heartbeatRuns).set({
        invocationSource: "automation", triggerDetail: "system",
        ...(rejection === "invalid recovery admission"
          ? { runnerProfileJson: { chatControlRecoveryAdmission: { phase: "invalid" } } }
          : {}),
      }).where(sql`${heartbeatRuns.id} = ${deferred}`);

      // Repeat with new healthy work each sweep: the older run remains queued,
      // but must never reserve the only slot while its admission is deferred.
      for (let sweep = 0; sweep < 2; sweep++) {
        const healthy = await insertRun(companyId, agentB, "queued", 60_000);
        adapterGate = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
        await heartbeat.resumeQueuedRuns();
        expect(await runStatus(deferred)).toMatchObject({ status: "queued" });
        expect(await runStatus(healthy)).toMatchObject({ status: "running" });
        adapterGate = null;
        releaseHeldRun();
        await heartbeat.drainActiveRunExecutions();
        expect(await runStatus(healthy)).toMatchObject({ status: "succeeded" });
      }
      expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    },
  );

  it("scans past a saturated agent's 25 older rows before allowing cap=2 self-refill", async () => {
    const capTwo = heartbeatService(db, {
      runtimeEnv: { HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS: "2" },
    });
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Older Runnable Agent A");
    const agentB = await insertAgent(companyId, "Self-refill Agent B");
    const agentC = await insertAgent(companyId, "Saturated Agent C");
    await db.update(agents).set({
      runtimeConfig: { heartbeat: { enabled: true, maxConcurrentRuns: 1 } },
    }).where(sql`${agents.id} = ${agentC}`);
    await insertRun(companyId, agentC, "running");
    adapterGate = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
    await insertRun(companyId, agentB, "queued");
    await capTwo.resumeQueuedRuns();
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 5000 });

    for (let i = 0; i < 26; i++) await insertRun(companyId, agentC, "queued", 7_200_000);
    // Tied timestamps with sub-millisecond precision exercise the page cursor.
    await db.update(heartbeatRuns).set({
      createdAt: sql`date_trunc('milliseconds', now() - interval '2 hours') + interval '123 microseconds'`,
    }).where(sql`${heartbeatRuns.agentId} = ${agentC} and ${heartbeatRuns.status} = 'queued'`);
    const olderA = await insertRun(companyId, agentA, "queued", 3_600_000);
    const youngerB = await insertRun(companyId, agentB, "queued", 60_000);
    adapterGate = null;
    releaseHeldRun();
    await capTwo.drainActiveRunExecutions();
    expect(await runStatus(youngerB)).toMatchObject({ status: "queued" });

    adapterGate = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
    try {
      await capTwo.resumeQueuedRuns();
      expect(await runStatus(olderA)).toMatchObject({ status: "running" });
      expect(await runStatus(youngerB)).toMatchObject({ status: "queued" });
      const queuedC = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${agentC} and ${heartbeatRuns.status} = 'queued'`);
      expect(queuedC).toHaveLength(26);
    } finally {
      adapterGate = null;
      releaseHeldRun();
      await capTwo.drainActiveRunExecutions();
    }
  });

  it("reserves for an older permitted comment wake on a dependency-blocked issue", async () => {
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Comment Agent A");
    const agentB = await insertAgent(companyId, "Self-refill Agent B");
    adapterGate = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
    await insertRun(companyId, agentB, "queued");
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const blockerId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Unresolved blocker", status: "todo" },
      { id: issueId, companyId, title: "Blocked issue", status: "todo",
        assigneeAgentId: agentA, responsibleUserId: "board-user" },
    ]);
    await db.insert(issueRelations).values({
      companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks",
    });
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board-user", body: "Explain the blocker.",
    });
    const olderA = await insertRun(companyId, agentA, "queued", 3_600_000, issueId);
    await db.update(heartbeatRuns).set({
      invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: commentId },
    }).where(sql`${heartbeatRuns.id} = ${olderA}`);
    await db.update(agentWakeupRequests).set({
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, commentId },
    }).where(sql`${agentWakeupRequests.runId} = ${olderA}`);
    const youngerB = await insertRun(companyId, agentB, "queued", 60_000);

    adapterGate = null;
    releaseHeldRun();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(youngerB)).toMatchObject({ status: "queued" });
    adapterGate = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(olderA)).toMatchObject({ status: "running" });
    expect(await runStatus(youngerB)).toMatchObject({ status: "queued" });
    adapterGate = null;
    releaseHeldRun();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(olderA)).toMatchObject({ status: "succeeded" });
  });

  it("keeps first-come-first-served self-refill when HEARTBEAT_GLOBAL_CLAIM_FAIRNESS=off", async () => {
    const fairnessOff = heartbeatService(db, {
      runtimeEnv: {
        HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS: "1",
        HEARTBEAT_GLOBAL_CLAIM_FAIRNESS: "off",
      },
    });
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Legacy Starved Agent A");
    const agentB = await insertAgent(companyId, "Legacy Self-refill Agent B");
    adapterGate = new Promise<void>((resolve) => {
      releaseHeldRun = resolve;
    });
    await insertRun(companyId, agentB, "queued");
    await fairnessOff.resumeQueuedRuns();
    // Explicit timeout: the claim->adapter dispatch hop is fire-and-forget and
    // can exceed vi.waitFor's 1s default on a cold, loaded run (observed flake,
    // review finding 4).
    await vi.waitFor(
      () => {
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    const queuedOldA = await insertRun(companyId, agentA, "queued", 3_600_000);
    const queuedNewB = await insertRun(companyId, agentB, "queued", 60_000);

    adapterGate = null;
    releaseHeldRun();
    await fairnessOff.drainActiveRunExecutions();

    // Kill switch restores legacy behavior: B's self-refill claims the freed
    // slot even though A's run is strictly older.
    expect(await runStatus(queuedNewB)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(queuedOldA)).toMatchObject({ status: "queued" });
  });

  // Review finding 3: the claimability mirror must NOT reserve for an
  // unclaimable older run. A's old run points at an issue that is currently
  // executing under another live run (executionRunId set, non-terminal), so
  // lockIssueExecutionClaim blocks its claim (issueClaim.blocked); if it still
  // reserved the freed slot the fleet would head-of-line block behind a run
  // that cannot claim. Cap 2 leaves the executing run's slot honest: one slot
  // is the executing run, the other is the race under test.
  it("does not reserve the freed slot for an older unclaimable run (issue executing) - no head-of-line blocking", async () => {
    const capTwo = heartbeatService(db, {
      runtimeEnv: { HEARTBEAT_GLOBAL_MAX_CONCURRENT_RUNS: "2" },
    });
    const companyId = await insertCompany();
    const agentA = await insertAgent(companyId, "Locked Agent A");
    const agentB = await insertAgent(companyId, "Refill Agent B");
    const agentC = await insertAgent(companyId, "Executor Agent C");
    // The issue's live executing run: non-terminal executionRunId genuinely
    // blocks A's claim (verified in lockIssueExecutionClaim), and it holds one
    // of the two fleet-wide slots for the whole scenario.
    const executingRunId = await insertRun(companyId, agentC, "running");
    const executingIssueId = randomUUID();
    await db.insert(issues).values({
      id: executingIssueId,
      companyId,
      title: "Issue executing under another run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentA,
      executionRunId: executingRunId,
    });
    adapterGate = new Promise<void>((resolve) => {
      releaseHeldRun = resolve;
    });
    await insertRun(companyId, agentB, "queued");
    await capTwo.resumeQueuedRuns();
    // Explicit timeout: the claim->adapter dispatch hop is fire-and-forget and
    // can exceed vi.waitFor's 1s default on a cold, loaded run (observed flake,
    // review finding 4).
    await vi.waitFor(
      () => {
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );

    const lockedOldA = await insertRun(
      companyId,
      agentA,
      "queued",
      3_600_000,
      executingIssueId,
    );
    const queuedNewB = await insertRun(companyId, agentB, "queued", 60_000);

    adapterGate = null;
    releaseHeldRun();
    await capTwo.drainActiveRunExecutions();

    // A's old run is unclaimable and reserves nothing: B's self-refill takes
    // the freed slot immediately, exactly as it would with no backlog.
    expect(await runStatus(queuedNewB)).toMatchObject({ status: "succeeded" });
    expect(await runStatus(lockedOldA)).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });
});
