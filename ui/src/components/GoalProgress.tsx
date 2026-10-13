import { useQuery } from "@tanstack/react-query";
import type { GoalProgressAgent, GoalProgressGoal, GoalProgressResponse, GoalProgressStage } from "@paperclipai/shared";
import { goalProgressApi } from "../api/goalProgress";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

const stageLabels: Record<GoalProgressStage, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

export function Bar({ percent, label, size = "md" }: { percent: number; label: string; size?: "sm" | "md" | "lg" }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const height = size === "lg" ? "h-4" : size === "sm" ? "h-1.5" : "h-2.5";
  return (
    <div
      className={`${height} w-full overflow-hidden rounded-full bg-muted`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      {/* Width is live data (percent complete), not a design constant. */}
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function taskSummary(goal: GoalProgressGoal): string {
  const { done, total, inProgress, inReview, blocked } = goal.counts;
  const parts = [`${done} of ${total} tasks done`];
  if (inProgress + inReview > 0) parts.push(`${inProgress + inReview} in progress`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(" · ");
}

function MilestoneRow({ goal }: { goal: GoalProgressGoal }) {
  return (
    <li className="flex min-w-0 flex-col gap-1" data-testid="goal-progress-milestone">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{goal.title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{Math.round(goal.percent)}%</span>
      </div>
      <Bar percent={goal.percent} label={`${goal.title} progress`} size="sm" />
      <span className="text-xs text-muted-foreground">{goal.status === "planned" && goal.counts.total === 0 ? "Not started" : taskSummary(goal)}</span>
    </li>
  );
}

function TeamGoal({ goal, byId }: { goal: GoalProgressGoal; byId: Map<string, GoalProgressGoal> }) {
  const milestones = goal.childIds.map((id) => byId.get(id)).filter((child): child is GoalProgressGoal => !!child && child.status !== "cancelled");
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={goal.title} data-testid="goal-progress-team">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate font-medium">{goal.title}</h3>
        <span className="shrink-0 font-mono text-sm">{Math.round(goal.percent)}%</span>
      </div>
      <Bar percent={goal.percent} label={`${goal.title} progress`} />
      <span className="text-xs text-muted-foreground">{taskSummary(goal)}</span>
      {milestones.length > 0 && (
        <ul className="mt-1 flex flex-col gap-2 border-l border-border pl-3">
          {milestones.map((milestone) => <MilestoneRow key={milestone.id} goal={milestone} />)}
        </ul>
      )}
    </section>
  );
}

function AgentRow({ agent }: { agent: GoalProgressAgent }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3" data-testid="goal-progress-agent">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <Link to={`/issues/${agent.identifier ?? agent.issueId}`} className="truncate text-xs text-muted-foreground hover:underline">
          {agent.identifier ? `${agent.identifier} · ` : ""}{agent.title}
        </Link>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {agent.goalTitle ? (
          <span className="max-w-56 truncate text-xs text-muted-foreground" title={agent.goalTitle}>{agent.goalTitle}</span>
        ) : (
          <Badge variant="outline" className="text-(--status-task-icon-todo)">no goal</Badge>
        )}
        <Badge variant="secondary">{stageLabels[agent.stage]}</Badge>
      </div>
    </li>
  );
}

export function GoalProgressView({ data }: { data: GoalProgressResponse }) {
  const byId = new Map(data.goals.map((goal) => [goal.id, goal]));
  const teams = data.goals.filter((goal) => goal.level === "team" && goal.status !== "cancelled");
  const roots = teams.length > 0 ? teams : data.goals.filter((goal) => goal.parentId === null && goal.status !== "cancelled");
  return (
    <CardContent className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" data-testid="goal-progress-overall">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Everything, until the final product</span>
          <span className="font-mono text-lg">{Math.round(data.overall.percent)}%</span>
        </div>
        <Bar percent={data.overall.percent} label="Overall progress" size="lg" />
        <span className="text-xs text-muted-foreground">
          {data.overall.counts.done} of {data.overall.counts.total} tasks done across all goals
          {data.unlinkedOpenTasks > 0 ? ` · ${data.unlinkedOpenTasks} open ${data.unlinkedOpenTasks === 1 ? "task has" : "tasks have"} no goal` : ""}
        </span>
      </div>
      {roots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No goals yet. Add them on the <Link to="/goals" className="underline">Goals page</Link>.</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {roots.map((goal) => <TeamGoal key={goal.id} goal={goal} byId={byId} />)}
        </div>
      )}
      <div>
        <h3 className="text-sm font-medium">Who is on what</h3>
        {data.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent has an open task right now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.agents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
          </ul>
        )}
      </div>
    </CardContent>
  );
}

export function GoalProgress({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.progress(companyId),
    queryFn: ({ signal }) => goalProgressApi.get(companyId, signal),
    refetchInterval: 60_000,
  });
  return (
    <Card className="block" data-testid="goal-progress">
      <CardHeader>
        <CardTitle>Goal progress</CardTitle>
        <CardDescription>
          Where every agent is on its task, and how far the whole plan is from the final product. <Link to="/goals" className="underline">Goal board</Link>
        </CardDescription>
      </CardHeader>
      {isLoading && <CardContent className="text-sm text-muted-foreground">Loading goal progress…</CardContent>}
      {error && <CardContent className="text-sm text-muted-foreground">Goal progress is unavailable right now.</CardContent>}
      {data && <GoalProgressView data={data} />}
    </Card>
  );
}
