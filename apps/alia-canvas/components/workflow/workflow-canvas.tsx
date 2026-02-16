"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type EdgeChange,
  type Connection,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowNode } from "@/lib/workflow-types";
import {
  GitHubNode,
  AITextNode,
  OutputNode,
  TextInputNode,
  MergeNode,
} from "./nodes";

interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<WorkflowNode>;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodesUpdate: (nodes: WorkflowNode[]) => void;
  onEdgesUpdate: (edges: Edge[]) => void;
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
}: WorkflowCanvasProps) {
  const nodeTypes: NodeTypes = useMemo(
    () => ({
      github: GitHubNode,
      aiText: AITextNode,
      aiImage: AITextNode, // Reuse AITextNode for now
      output: OutputNode,
      textInput: TextInputNode,
      merge: MergeNode,
      condition: MergeNode, // Reuse MergeNode for now
      memory: MergeNode, // Reuse MergeNode for now
    }),
    []
  );

  return (
    <div className="flex-1 bg-workflow-bg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        defaultEdgeOptions={{
          type: "smoothstep",
          animated: true,
          style: { strokeWidth: 2 },
        }}
        className="bg-workflow-bg"
      >
        <Background gap={16} size={1} />
        <Controls className="bg-card border border-border rounded-lg shadow-lg" />
        <MiniMap
          nodeStrokeWidth={3}
          zoomable
          pannable
          position="bottom-right"
          className="bg-card border border-border rounded-lg shadow-lg"
        />
      </ReactFlow>
    </div>
  );
}
