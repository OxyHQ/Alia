import { useQuery } from "@tanstack/react-query";
import apiClient from "../api/client";
import { API_ROUTES } from "../api/routes";

export interface ActivityGridDay {
  date: string; // "YYYY-MM-DD"
  count: number;
}

export interface ActivityGridData {
  grid: ActivityGridDay[];
  totalSessions: number;
  maxCount: number;
}

export function useActivityGrid(agentId: string, weeks: number = 52) {
  return useQuery<ActivityGridData>({
    queryKey: ["agent-activity-grid", agentId, weeks],
    queryFn: async () => {
      const res = await apiClient.get(
        API_ROUTES.agents.activityGrid(agentId),
        { params: { weeks } }
      );
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: !!agentId,
  });
}
