import type { Node, Edge } from "@xyflow/react";

export type WorkflowNodeType =
  | "aiText"
  | "aiImage"
  | "condition"
  | "memory"
  | "github"
  | "output"
  | "textInput"
  | "merge";

export interface WorkflowNodeData {
  label: string;
  // AI Text Node
  /**
   * The `profile:*` identifier a node asks for, absent for Automatic.
   *
   * There was a `provider` field beside this and nothing ever wrote one — the
   * node badge read `data.provider || "openai"`, so the fallback was what every
   * node displayed. See `src/lib/product-modes.ts`.
   */
  model?: string;
  prompt?: string;
  systemPrompt?: string;
  temperature?: number;
  // AI Image Node
  size?: string;
  // Condition Node
  condition?: string;
  operator?: string;
  value?: string;
  // Memory Node
  memoryKey?: string;
  operation?: string;
  dataType?: string;
  defaultValue?: string;
  // GitHub Node
  githubUrl?: string;
  branch?: string;
  fetchReadme?: boolean;
  fetchStructure?: boolean;
  fetchKeyFiles?: boolean;
  // Output Node
  outputType?: string;
  agentType?: string;
  customFilename?: string;
  customTemplate?: string;
  // Text Input Node
  text?: string;
  // Merge Node
  separator?: string;
  // Index signature for React Flow compatibility
  [key: string]: unknown;
}

export interface WorkflowNode extends Node {
  type: WorkflowNodeType;
  data: WorkflowNodeData;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "failed";
  results: WorkflowExecutionResult[];
  finalOutput: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface WorkflowExecutionResult {
  nodeId: string;
  nodeType: string;
  output: unknown;
  error?: string;
  timestamp: Date;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: Edge[];
  createdAt: Date;
  updatedAt: Date;
}
