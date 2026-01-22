"use client";

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./base-node";
import { Type } from "lucide-react";

export const TextInputNode = memo(function TextInputNode({ id, data, selected }: NodeProps) {
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
