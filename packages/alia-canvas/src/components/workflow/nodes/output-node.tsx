import { memo } from "react";
import { BaseNode } from "./base-node";
import { FileOutput } from "lucide-react";
import type { WorkflowNodeData } from "@/lib/workflow-types";

interface OutputNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
}

export const OutputNode = memo(function OutputNode({ id, data, selected }: OutputNodeProps) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      icon={<FileOutput className="w-3.5 h-3.5 text-red-500" />}
      sourceHandle={false}
    >
      <div className="space-y-1.5">
        <input
          placeholder="output.md"
          value={data.customFilename || "README.md"}
          className="w-full px-2 py-1 text-xs bg-background border border-input rounded"
          disabled
        />
        <div className="text-[10px] text-muted-foreground">
          Output: <span className="font-mono text-foreground">{data.outputType || "readme-md"}</span>
        </div>
      </div>
    </BaseNode>
  );
});
