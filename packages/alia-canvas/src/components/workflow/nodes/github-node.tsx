import { memo } from "react";
import { BaseNode } from "./base-node";
import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkflowNodeData } from "@/lib/workflow-types";

interface GitHubNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
}

export const GitHubNode = memo(function GitHubNode({ id, data, selected }: GitHubNodeProps) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      icon={<GitBranch className="w-3.5 h-3.5" />}
      targetHandle={false}
    >
      <div className="space-y-1.5">
        <input
          placeholder="Enter GitHub URL"
          value={data.githubUrl || ""}
          className="w-full px-2 py-1 text-xs bg-background border border-input rounded text-muted-foreground"
          disabled
        />
        <div className="flex gap-1 flex-wrap text-[10px]">
          {data.fetchReadme && <Badge variant="secondary" className="h-4 px-1.5">README</Badge>}
          {data.fetchStructure && <Badge variant="secondary" className="h-4 px-1.5">Structure</Badge>}
          {data.fetchKeyFiles && <Badge variant="secondary" className="h-4 px-1.5">Files</Badge>}
        </div>
      </div>
    </BaseNode>
  );
});
