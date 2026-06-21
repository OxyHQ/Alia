"use client";

import { memo } from "react";
import { BaseNode } from "./base-node";
import { GitMerge } from "lucide-react";
import type { WorkflowNodeData } from "@/lib/workflow-types";

interface MergeNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
}

export const MergeNode = memo(function MergeNode({ id, data, selected }: MergeNodeProps) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      icon={<GitMerge className="w-3.5 h-3.5" />}
    >
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground">Separator</div>
        <input
          placeholder="\\n\\n"
          value={data.separator || "\\n\\n"}
          className="w-full px-2 py-1 text-xs bg-background border border-input rounded font-mono"
          disabled
        />
      </div>
    </BaseNode>
  );
});
