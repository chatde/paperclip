// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalProgressResponse } from "@paperclipai/shared";
import { GoalProgressView } from "./GoalProgress";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The app's Link adds the active company prefix, which needs CompanyProvider; a plain anchor is enough here.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode } & Record<string, unknown>) => <a href={to} {...rest}>{children}</a>,
}));

const counts = (done: number, total: number) => ({ done, inProgress: 0, inReview: 0, blocked: 0, todo: total - done, total });

const data: GoalProgressResponse = {
  overall: { percent: 40, counts: counts(4, 10) },
  unlinkedOpenTasks: 2,
  goals: [
    { id: "c", title: "Company", level: "company", status: "active", parentId: null, ownerAgentId: null, percent: 40, counts: counts(4, 10), childIds: ["t"] },
    { id: "t", title: "Pantheon runs itself", level: "team", status: "active", parentId: "c", ownerAgentId: null, percent: 40, counts: counts(4, 10), childIds: ["m1", "m2"] },
    { id: "m1", title: "M1: stable server", level: "task", status: "active", parentId: "t", ownerAgentId: null, percent: 80, counts: counts(4, 5), childIds: [] },
    { id: "m2", title: "M2: 90% runs", level: "task", status: "planned", parentId: "t", ownerAgentId: null, percent: 0, counts: counts(0, 0), childIds: [] },
  ],
  agents: [
    { agentId: "a", name: "Jev", agentStatus: "running", issueId: "i1", identifier: "TOP-1", title: "Route things", stage: "in_progress", goalId: "m1", goalTitle: "M1: stable server" },
    { agentId: "b", name: "Rogue", agentStatus: "idle", issueId: "i2", identifier: "TOP-2", title: "Mystery work", stage: "in_review", goalId: null, goalTitle: null },
  ],
};

let container: HTMLDivElement;
let root: Root;
async function render(value: GoalProgressResponse) {
  await act(async () => {
    root.render(<MemoryRouter><GoalProgressView data={value} /></MemoryRouter>);
  });
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("GoalProgressView", () => {
  it("shows the overall bar, each milestone, and who is on what", async () => {
    await render(data);
    const bar = (label: string) => container.querySelector(`[role="progressbar"][aria-label="${label}"]`);
    expect(bar("Overall progress")?.getAttribute("aria-valuenow")).toBe("40");
    expect(bar("M1: stable server progress")?.getAttribute("aria-valuenow")).toBe("80");
    expect(container.textContent).toContain("4 of 10 tasks done across all goals · 2 open tasks have no goal");
    expect(container.querySelectorAll('[data-testid="goal-progress-milestone"]')).toHaveLength(2);
    expect(container.textContent).toContain("Not started");
    const agents = container.querySelectorAll('[data-testid="goal-progress-agent"]');
    expect(agents).toHaveLength(2);
    expect(agents[0].textContent).toContain("Jev");
    expect(agents[0].textContent).toContain("In progress");
    expect(agents[1].textContent).toContain("no goal");
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("TOP-2"));
    expect(link?.getAttribute("href")).toBe("/issues/TOP-2");
  });

  it("explains an empty board instead of rendering nothing", async () => {
    await render({ overall: { percent: 0, counts: counts(0, 0) }, goals: [], agents: [], unlinkedOpenTasks: 0 });
    expect(container.textContent).toContain("No goals yet");
    expect(container.textContent).toContain("No agent has an open task right now.");
  });
});
