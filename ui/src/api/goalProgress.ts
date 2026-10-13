import type { GoalProgressResponse } from "@paperclipai/shared";
import { api } from "./client";

export const goalProgressApi = {
  get: (companyId: string, signal?: AbortSignal) =>
    api.get<GoalProgressResponse>(`/companies/${companyId}/goal-progress`, { signal, cache: "no-store" }),
};
