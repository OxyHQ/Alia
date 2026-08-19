import { memo } from "react";
import { BaseNode } from "./base-node";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkflowNodeData } from "@/lib/workflow-types";
import { labelForNode, useOfferedModes } from "@/lib/product-modes";

interface AITextNodeProps {
  id: string;
  data: WorkflowNodeData;
  selected?: boolean;
}

export const AITextNode = memo(function AITextNode({ id, data, selected }: AITextNodeProps) {
  const { data: offeredModes } = useOfferedModes();
  /**
   * The product's word for what this node is set to, or nothing.
   *
   * There used to be two badges here, and neither said anything true: the first
   * read `data.provider || "openai"` and no node has ever carried a `provider`,
   * so it named an operator on every node in the editor; the second read
   * `data.model || "gpt-4o"`, a provider model id. One badge now, holding the
   * mode, and absent when the modes have not loaded or when the node names
   * something the product has no word for.
   */
  const modeLabel = labelForNode(data.model, offeredModes);

  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      icon={<Sparkles className="w-3.5 h-3.5 text-primary" />}
    >
      <div className="space-y-1.5">
        {modeLabel !== null && (
          <div className="flex gap-1 text-[10px]">
            <Badge variant="outline" className="h-4 px-1.5">
              {modeLabel}
            </Badge>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground line-clamp-1">
          {data.systemPrompt || "You are a technical documentation expert."}
        </div>

        <div className="text-[10px] text-foreground/80 line-clamp-3 p-1.5 bg-muted/50 rounded text-left">
          {data.prompt || "Enter prompt..."}
        </div>

        <div className="flex items-center gap-1.5 pt-0.5">
          <span className="text-[10px] text-muted-foreground">Temp:</span>
          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${((data.temperature || 0.7) / 2) * 100}%` }}
            />
          </div>
          <span className="text-[10px] font-medium w-6 text-right">{data.temperature || 0.7}</span>
        </div>
      </div>
    </BaseNode>
  );
});
