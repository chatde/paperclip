export type GoalProgressStage = "todo" | "in_progress" | "in_review" | "blocked" | "done";

export interface GoalProgressCounts {
  done: number;
  inProgress: number;
  inReview: number;
  blocked: number;
  todo: number;
  /** Tasks that count toward the goal (everything except cancelled). */
  total: number;
}

export interface GoalProgressGoal {
  id: string;
  title: string;
  level: string;
  status: string;
  parentId: string | null;
  ownerAgentId: string | null;
  /** 0-100. Achieved goals are 100; a goal with child goals is the mean of its children. */
  percent: number;
  /** Counts over the goal's own tasks plus every descendant goal's tasks. */
  counts: GoalProgressCounts;
  childIds: string[];
}

export interface GoalProgressAgent {
  agentId: string;
  name: string;
  agentStatus: string;
  issueId: string;
  /** Null for tasks that never got an identifier; link by issueId then. */
  identifier: string | null;
  title: string;
  stage: GoalProgressStage;
  goalId: string | null;
  goalTitle: string | null;
}

export interface GoalProgressResponse {
  overall: { percent: number; counts: GoalProgressCounts };
  goals: GoalProgressGoal[];
  agents: GoalProgressAgent[];
  /** Open tasks with no goal at all: work nobody can trace to the plan. */
  unlinkedOpenTasks: number;
}
