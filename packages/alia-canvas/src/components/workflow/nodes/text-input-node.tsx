import { memo } from "react";
import { BaseNode } from "./base-node";
import { Type } from "lucide-react";
import type { WorkflowNodeData } from "@/lib/workflow-types";

interface TextInputNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
}

export const TextInputNode = memo(function TextInputNode({ id, data, selected }: TextInputNodeProps) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      icon={<Type className="w-3.5 h-3.5" />}
      targetHandle={false}
    >
      <textarea
        placeholder="Enter text..."
        value={data.text || ""}
        className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
        rows={3}
        disabled
      />
    </BaseNode>
  );
});
