"use client";

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./base-node";
import { GitMerge } from "lucide-react";

export const MergeNode = memo(function MergeNode({ id, data, selected }: NodeProps) {
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
