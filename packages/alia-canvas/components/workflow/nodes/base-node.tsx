"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Card } from "@/components/ui/card";
import type { WorkflowNodeData } from "@/lib/workflow-types";

interface BaseNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  sourceHandle?: boolean;
  targetHandle?: boolean;
}

export const BaseNode = memo(function BaseNode({
  data,
  selected,
  children,
  icon,
  sourceHandle = true,
  targetHandle = true,
}: BaseNodeProps) {
  return (
    <div className="relative">
      {targetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          className="w-2 h-2 !bg-primary border-2 border-background"
        />
      )}

      <Card
        className={`min-w-[220px] max-w-[280px] p-3 transition-all ${
          selected
            ? "ring-2 ring-primary shadow-lg"
            : "shadow hover:shadow-md"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          {icon}
          <div className="text-xs font-semibold truncate">{data.label}</div>
        </div>
        {children}
      </Card>

      {sourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          className="w-2 h-2 !bg-primary border-2 border-background"
        />
      )}
    </div>
  );
});
