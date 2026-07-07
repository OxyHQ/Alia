import { useState, useCallback } from "react";
import {
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
} from "@xyflow/react";

import type { WorkflowNode, WorkflowNodeType, WorkflowExecution } from "@/lib/workflow-types";
import { WorkflowCanvas } from "./workflow-canvas";
import { WorkflowToolbar } from "./workflow-toolbar";
import { OutputPanel } from "./output-panel";
import { LoadWorkflowDialog } from "./load-workflow-dialog";
import { NodeEditPanel } from "./node-edit-panel";
import { RunHistoryDialog } from "./run-history-dialog";

// Alia workflow API base (workflows, execute). Overridable at build time.
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Default README Generator template
const initialNodes: WorkflowNode[] = [
  {
    id: "github-1",
    type: "github",
    position: { x: 50, y: 200 },
    data: {
      label: "GitHub Repo",
      githubUrl: "",
      branch: "main",
      fetchReadme: true,
      fetchStructure: true,
      fetchKeyFiles: true,
    },
  },
  {
    id: "ai-1",
    type: "aiText",
    position: { x: 450, y: 150 },
    data: {
      label: "Generate README",
      model: "alia-lite",
      prompt:
        "Based on the following repository context, generate a comprehensive README.md file with sections for: Overview, Features, Installation, Usage, API Reference (if applicable), and Contributing guidelines.\n\n{{input}}",
      systemPrompt: "You are a technical documentation expert.",
      temperature: 0.7,
    },
  },
  {
    id: "output-1",
    type: "output",
    position: { x: 900, y: 200 },
    data: {
      label: "README Output",
      outputType: "readme-md",
      customFilename: "README.md",
      customTemplate: "",
    },
  },
];
const initialEdges: Edge[] = [
  { id: "e1", source: "github-1", target: "ai-1", type: "default", animated: true },
  { id: "e2", source: "ai-1", target: "output-1", type: "default", animated: true },
];

// Static per-node-type default data. Module-scoped so it stays referentially
// stable across renders (no need to thread it through hook dependency arrays).
const defaultNodeData: Record<WorkflowNodeType, object> = {
  aiText: {
    label: "AI Text",
    model: "alia-lite",
    prompt: "",
    systemPrompt: "",
    temperature: 0.7,
  },
  aiImage: {
    label: "AI Image",
    model: "alia-lite",
    prompt: "",
    size: "1024x1024",
  },
  condition: {
    label: "Condition",
    condition: "",
    operator: "contains",
    value: "",
  },
  memory: {
    label: "Memory",
    memoryKey: "",
    operation: "read",
    dataType: "text",
    defaultValue: "",
  },
  github: {
    label: "GitHub",
    githubUrl: "",
    branch: "main",
    fetchReadme: true,
    fetchStructure: true,
    fetchKeyFiles: false,
  },
  output: {
    label: "Output",
    outputType: "readme-md",
    agentType: undefined,
    customFilename: "",
    customTemplate: "",
  },
  textInput: {
    label: "Text Input",
    text: "",
  },
  merge: {
    label: "Merge",
    separator: "\n\n",
  },
};

function WorkflowEditorInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState("README Generator");
  const [hasChanges, setHasChanges] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, type: "default", animated: true }, eds));
      setHasChanges(true);
    },
    [setEdges]
  );

  const handleAddNode = useCallback(
    (nodeType: WorkflowNodeType) => {
      // Calculate position based on existing nodes - place horizontally with 400px spacing
      const xOffset = 100 + nodes.length * 400;
      const newNode: WorkflowNode = {
        id: `${nodeType}-${Date.now()}`,
        type: nodeType,
        position: { x: xOffset, y: 200 },
        data: defaultNodeData[nodeType] as WorkflowNode["data"],
      };
      setNodes((nds) => [...nds, newNode]);
      setHasChanges(true);
    },
    [nodes.length, setNodes]
  );

  const handleNodesUpdate = useCallback(
    (newNodes: WorkflowNode[]) => {
      setNodes(newNodes);
      setHasChanges(true);
    },
    [setNodes]
  );

  const handleEdgesUpdate = useCallback(
    (newEdges: Edge[]) => {
      setEdges(newEdges);
      setHasChanges(true);
    },
    [setEdges]
  );

  const handleNodeUpdate = useCallback(
    (nodeId: string, data: Partial<WorkflowNode["data"]>) => {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, ...data } as WorkflowNode["data"] }
            : node
        )
      );
      setSelectedNode((prev) =>
        prev && prev.id === nodeId
          ? { ...prev, data: { ...prev.data, ...data } as WorkflowNode["data"] }
          : prev
      );
      setHasChanges(true);
    },
    [setNodes]
  );

  const handleExecute = async () => {
    if (nodes.length === 0) return;

    setIsExecuting(true);
    setShowOutput(true);
    setExecution(null);

    try {
      const response = await fetch(`${API_URL}/api/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ nodes, edges, workflowId }),
      });

      const result = await response.json();

      if (response.ok) {
        setExecution({
          id: crypto.randomUUID(),
          workflowId: workflowId || "",
          status: "completed",
          results: result.results,
          finalOutput: result.finalOutput,
          startedAt: new Date(),
          completedAt: new Date(),
        });
      } else {
        setExecution({
          id: crypto.randomUUID(),
          workflowId: workflowId || "",
          status: "failed",
          results: [
            {
              nodeId: "error",
              nodeType: "output",
              output: null,
              error: result.error,
              timestamp: new Date(),
            },
          ],
          finalOutput: `Error: ${result.error}`,
          startedAt: new Date(),
          completedAt: new Date(),
        });
      }
    } catch (error) {
      setExecution({
        id: crypto.randomUUID(),
        workflowId: workflowId || "",
        status: "failed",
        results: [],
        finalOutput: `Execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        startedAt: new Date(),
        completedAt: new Date(),
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);

    try {
      const url = workflowId ? `${API_URL}/api/workflows/${workflowId}` : `${API_URL}/api/workflows`;
      const method = workflowId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: workflowName,
          nodes,
          edges,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        if (!workflowId) {
          setWorkflowId(result.workflow.id);
        }
        setHasChanges(false);
      }
    } catch (error) {
      console.error("Failed to save workflow:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoad = async (id: string) => {
    try {
      const response = await fetch(`${API_URL}/api/workflows/${id}`);
      const result = await response.json();

      if (response.ok && result.workflow) {
        setWorkflowId(result.workflow.id);
        setWorkflowName(result.workflow.name);
        setNodes(result.workflow.nodes || []);
        setEdges(result.workflow.edges || []);
        setHasChanges(false);
        setShowLoadDialog(false);
      }
    } catch (error) {
      console.error("Failed to load workflow:", error);
    }
  };

  const handleNew = () => {
    setWorkflowId(null);
    setWorkflowName("Untitled Workflow");
    setNodes([]);
    setEdges([]);
    setHasChanges(false);
    setExecution(null);
    setSelectedNode(null);
  };

  const handleClear = () => {
    setNodes([]);
    setEdges([]);
    setHasChanges(true);
    setSelectedNode(null);
  };

  const handleSelectTemplate = (templateNodes: WorkflowNode[], templateEdges: Edge[], name: string) => {
    setWorkflowId(null);
    setWorkflowName(name);
    setNodes(templateNodes);
    setEdges(templateEdges);
    setHasChanges(true);
    setSelectedNode(null);
  };

  const handleSelectHistoryRun = (output: string) => {
    setExecution({
      id: crypto.randomUUID(),
      workflowId: workflowId || "",
      status: "completed",
      results: [],
      finalOutput: output,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    setShowOutput(true);
  };

  const handleNodesChangeWrapper: typeof onNodesChange = (changes) => {
    onNodesChange(changes);

    for (const change of changes) {
      if (change.type === "select" && change.selected) {
        const node = nodes.find((n) => n.id === change.id);
        if (node) {
          setSelectedNode(node as WorkflowNode);
        }
      }
    }
  };

  return (
    <div className="h-screen flex flex-col bg-workflow-bg transition-colors duration-200">
      <WorkflowToolbar
        workflowName={workflowName}
        onWorkflowNameChange={(name) => {
          setWorkflowName(name);
          setHasChanges(true);
        }}
        onExecute={handleExecute}
        onSave={handleSave}
        onLoad={() => setShowLoadDialog(true)}
        onNew={handleNew}
        onClear={handleClear}
        onOpenHistory={() => setShowHistoryDialog(true)}
        onSelectTemplate={handleSelectTemplate}
        onAddNode={handleAddNode}
        onToggleOutput={() => setShowOutput(!showOutput)}
        isExecuting={isExecuting}
        isSaving={isSaving}
        hasChanges={hasChanges}
        showOutput={showOutput}
      />

      <div className="flex-1 flex overflow-hidden">
        <WorkflowCanvas
          nodes={nodes as WorkflowNode[]}
          edges={edges}
          onNodesChange={handleNodesChangeWrapper}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodesUpdate={handleNodesUpdate}
          onEdgesUpdate={handleEdgesUpdate}
        />

        {selectedNode && !showOutput && (
          <NodeEditPanel
            node={selectedNode}
            onUpdate={handleNodeUpdate}
            onClose={() => setSelectedNode(null)}
          />
        )}

        {showOutput && (
          <OutputPanel
            execution={execution}
            isExecuting={isExecuting}
            onClose={() => setShowOutput(false)}
          />
        )}
      </div>

      <LoadWorkflowDialog
        isOpen={showLoadDialog}
        onClose={() => setShowLoadDialog(false)}
        onLoad={handleLoad}
      />

      <RunHistoryDialog
        isOpen={showHistoryDialog}
        onClose={() => setShowHistoryDialog(false)}
        workflowId={workflowId}
        onSelectRun={handleSelectHistoryRun}
      />
    </div>
  );
}

export function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}
