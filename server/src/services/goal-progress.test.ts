import { describe, expect, it } from "vitest";
import { computeGoalProgress, type ProgressIssueInput } from "./goal-progress.js";

const goal = (id: string, level: string, parentId: string | null = null, status = "active") => ({
  id, title: id, level, status, parentId, ownerAgentId: null,
});
const issue = (
  id: string,
  status: string,
  goalId: string | null,
  assigneeAgentId: string | null = null,
  extra: Partial<ProgressIssueInput> = {},
): ProgressIssueInput => ({
  id, identifier: `TOP-${id}`, title: `task ${id}`, status, goalId, assigneeAgentId, projectId: null, parentId: null, ...extra,
});

describe("computeGoalProgress", () => {
  it("scores a leaf goal by done over non-cancelled tasks", () => {
    const out = computeGoalProgress({
      goals: [goal("m1", "task")],
      issues: [issue("1", "done", "m1"), issue("2", "todo", "m1"), issue("3", "cancelled", "m1"), issue("4", "in_review", "m1")],
      agents: [],
    });
    const m1 = out.goals.find((g) => g.id === "m1")!;
    expect(m1.percent).toBe(33.3);
    expect(m1.counts).toEqual({ done: 1, inProgress: 0, inReview: 1, blocked: 0, todo: 1, total: 3 });
  });

  it("weights milestones equally under a team goal and rolls counts up to the company goal", () => {
    const out = computeGoalProgress({
      goals: [goal("c", "company"), goal("t", "team", "c"), goal("m1", "task", "t"), goal("m2", "task", "t")],
      issues: [issue("1", "done", "m1"), issue("2", "done", "m1"), issue("3", "todo", "m2"), issue("4", "todo", "m2"), issue("5", "todo", "m2"), issue("6", "done", "m2")],
      agents: [],
    });
    const byId = Object.fromEntries(out.goals.map((g) => [g.id, g]));
    expect(byId.m1.percent).toBe(100);
    expect(byId.m2.percent).toBe(25);
    // 2 of 6 tasks are done, but the milestones count equally: (100 + 25) / 2.
    expect(byId.t.percent).toBe(62.5);
    expect(byId.c.percent).toBe(62.5);
    expect(byId.c.counts.total).toBe(6);
    expect(out.overall.percent).toBe(62.5);
    expect(out.overall.counts.done).toBe(3);
  });

  it("treats achieved goals as 100 and ignores cancelled child goals", () => {
    const out = computeGoalProgress({
      goals: [goal("t", "team"), goal("m1", "task", "t", "achieved"), goal("m2", "task", "t", "cancelled"), goal("m3", "task", "t")],
      issues: [issue("1", "todo", "m3")],
      agents: [],
    });
    const byId = Object.fromEntries(out.goals.map((g) => [g.id, g]));
    expect(byId.m1.percent).toBe(100);
    expect(byId.t.percent).toBe(50);
  });

  it("falls back to the parent task's goal, then the project's goal, when a task has none", () => {
    const out = computeGoalProgress({
      goals: [goal("m1", "task"), goal("m2", "task")],
      projects: [{ id: "p1", goalId: "m1" }, { id: "p-nogoal", goalId: null }],
      issues: [
        issue("1", "done", null, null, { projectId: "p1" }),
        issue("2", "todo", null, "agent-a", { parentId: "1" }),
        issue("3", "in_progress", "m2", null, { projectId: "p1" }),
        issue("4", "todo", null, null, { projectId: "p-nogoal" }),
        issue("5", "todo", null, null, { parentId: "6" }),
        issue("6", "todo", null, null, { parentId: "5" }),
      ],
      agents: [{ id: "agent-a", name: "Ann", status: "idle" }],
    });
    const byId = Object.fromEntries(out.goals.map((g) => [g.id, g]));
    expect(byId.m1.counts).toEqual({ done: 1, inProgress: 0, inReview: 0, blocked: 0, todo: 1, total: 2 });
    expect(byId.m2.counts.total).toBe(1);
    expect(out.unlinkedOpenTasks).toBe(3);
    expect(out.agents[0]).toMatchObject({ name: "Ann", identifier: "TOP-2", goalId: "m1", goalTitle: "m1" });
  });

  it("inherits through a hidden parent and resolves parent cycles the same in any order", () => {
    const base = {
      goals: [goal("ga", "task"), goal("gb", "task"), goal("m1", "task")],
      projects: [{ id: "pa", goalId: "ga" }, { id: "pb", goalId: "gb" }],
      agents: [],
    };
    // Hidden parent (not in issues, only in ancestors) carrying the goal.
    const hidden = computeGoalProgress({
      ...base,
      issues: [issue("child", "todo", null, null, { parentId: "parent" })],
      ancestors: [{ id: "parent", goalId: "m1", projectId: null, parentId: null }],
    });
    expect(hidden.goals.find((g) => g.id === "m1")!.counts.total).toBe(1);
    expect(hidden.unlinkedOpenTasks).toBe(0);
    // Parent cycle with different project goals: each task falls back to its own project.
    const a = issue("a", "todo", null, null, { parentId: "b", projectId: "pa" });
    const b = issue("b", "todo", null, null, { parentId: "a", projectId: "pb" });
    for (const order of [[a, b], [b, a]]) {
      const out = computeGoalProgress({ ...base, issues: order });
      expect(out.goals.find((g) => g.id === "ga")!.counts.total).toBe(1);
      expect(out.goals.find((g) => g.id === "gb")!.counts.total).toBe(1);
    }
  });

  it("counts open tasks with no goal and never crashes on a goal cycle", () => {
    const out = computeGoalProgress({
      goals: [goal("a", "team", "b"), goal("b", "team", "a")],
      issues: [issue("1", "todo", null), issue("2", "done", null), issue("3", "in_progress", "missing-goal")],
      agents: [],
    });
    expect(out.unlinkedOpenTasks).toBe(2);
    expect(out.goals).toHaveLength(2);
  });

  it("gives cyclic goals the same counts and percent whatever the input order", () => {
    const run = (order: string[]) => {
      const defs: Record<string, ReturnType<typeof goal>> = { a: goal("a", "team", "b"), b: goal("b", "team", "a"), c: goal("c", "task", "b") };
      const out = computeGoalProgress({
        goals: order.map((id) => defs[id]),
        issues: [issue("1", "done", "a"), issue("2", "todo", "b"), issue("3", "done", "c"), issue("4", "todo", "c")],
        agents: [],
      });
      return Object.fromEntries(out.goals.map((g) => [g.id, { total: g.counts.total, done: g.counts.done, percent: g.percent }]));
    };
    const forward = run(["a", "b", "c"]);
    const reversed = run(["c", "b", "a"]);
    expect(forward).toEqual(reversed);
    // a reaches b and c; b reaches a and c: every goal in the cycle sees all 4 tasks once.
    expect(forward.a).toEqual({ total: 4, done: 2, percent: 50 });
    expect(forward.b).toEqual({ total: 4, done: 2, percent: 50 });
    expect(forward.c).toEqual({ total: 2, done: 1, percent: 50 });
  });

  it("reports each agent's furthest-along open task with its goal", () => {
    const out = computeGoalProgress({
      goals: [goal("m1", "task")],
      issues: [
        issue("1", "todo", "m1", "agent-a"),
        issue("2", "in_progress", "m1", "agent-a"),
        issue("3", "backlog", null, "agent-b"),
        issue("4", "in_review", null, "agent-c"),
        issue("5", "done", "m1", "agent-d"),
        issue("6", "blocked", "m1", "agent-e", { identifier: null }),
      ],
      agents: [
        { id: "agent-a", name: "Zed", status: "running" },
        { id: "agent-b", name: "Bea", status: "idle" },
        { id: "agent-c", name: "Cal", status: "idle" },
        { id: "agent-d", name: "Dee", status: "idle" },
        { id: "agent-e", name: "Eve", status: "idle" },
      ],
    });
    expect(out.agents.map((a) => [a.name, a.identifier, a.stage, a.goalTitle])).toEqual([
      ["Zed", "TOP-2", "in_progress", "m1"],
      ["Cal", "TOP-4", "in_review", null],
      ["Eve", null, "blocked", "m1"],
    ]);
  });
});
