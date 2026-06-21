"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus,
  Play,
  Save,
  FolderOpen,
  FileText,
  LayoutGrid,
  Trash2,
  History,
  Sun,
  Moon,
  Code2,
  LogOut,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { WorkflowNodeType, WorkflowNode } from "@/lib/workflow-types";
import type { Edge } from "@xyflow/react";

interface WorkflowToolbarProps {
  workflowName: string;
  onWorkflowNameChange: (name: string) => void;
  onExecute: () => void;
  onSave: () => void;
  onLoad: () => void;
  onNew: () => void;
  onClear: () => void;
  onOpenHistory: () => void;
  onSelectTemplate: (nodes: WorkflowNode[], edges: Edge[], name: string) => void;
  onAddNode: (nodeType: WorkflowNodeType) => void;
  onToggleOutput: () => void;
  isExecuting: boolean;
  isSaving: boolean;
  hasChanges: boolean;
  showOutput: boolean;
}

export function WorkflowToolbar({
  workflowName,
  onWorkflowNameChange,
  onExecute,
  onSave,
  onLoad,
  onNew,
  onClear,
  onOpenHistory,
  onAddNode,
  onToggleOutput,
  isExecuting,
  isSaving,
  hasChanges,
  showOutput,
}: WorkflowToolbarProps) {
  const { theme, setTheme } = useTheme();

  const nodeTypes: { type: WorkflowNodeType; label: string; icon: React.ReactNode }[] = [
    { type: "textInput", label: "Text Input", icon: <FileText className="w-4 h-4" /> },
    { type: "aiText", label: "AI Text", icon: <Code2 className="w-4 h-4" /> },
    { type: "github", label: "GitHub", icon: <Code2 className="w-4 h-4" /> },
    { type: "output", label: "Output", icon: <FileText className="w-4 h-4" /> },
    { type: "merge", label: "Merge", icon: <LayoutGrid className="w-4 h-4" /> },
  ];

  return (
    <div className="border-b bg-card px-4 py-2 flex items-center gap-3">
      {/* Logo/Brand */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Code2 className="w-5 h-5 text-primary" />
        </div>
        <span className="font-semibold text-sm hidden sm:block">Canvas by Alia</span>
      </div>

      {/* Workflow Name */}
      <div className="flex items-center gap-2 flex-1 max-w-md">
        <Input
          value={workflowName}
          onChange={(e) => onWorkflowNameChange(e.target.value)}
          className="h-9 text-sm"
          placeholder="Workflow name"
        />
        {hasChanges && (
          <div className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />
        )}
      </div>

      {/* Primary Actions */}
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9">
              <Plus className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Add Node</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Add Node</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {nodeTypes.map(({ type, label, icon }) => (
              <DropdownMenuItem key={type} onClick={() => onAddNode(type)}>
                {icon}
                <span className="ml-2">{label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="sm" className="h-9" onClick={onToggleOutput}>
          <LayoutGrid className="w-4 h-4 sm:mr-1.5" />
          <span className="hidden sm:inline">{showOutput ? "Hide" : "Show"} Output</span>
        </Button>

        <Button variant="ghost" size="sm" className="h-9" onClick={onClear}>
          <Trash2 className="w-4 h-4 sm:mr-1.5" />
          <span className="hidden sm:inline">Clear</span>
        </Button>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* File Actions */}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-9" onClick={onNew}>
          <FileText className="w-4 h-4" />
        </Button>

        <Button variant="ghost" size="sm" className="h-9" onClick={onLoad}>
          <FolderOpen className="w-4 h-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={onSave}
          disabled={isSaving || !hasChanges}
        >
          <Save className="w-4 h-4" />
        </Button>

        <Button variant="ghost" size="sm" className="h-9" onClick={onOpenHistory}>
          <History className="w-4 h-4" />
        </Button>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Theme Toggle */}
      <Button
        variant="ghost"
        size="sm"
        className="h-9 w-9"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </Button>

      <div className="h-6 w-px bg-border" />

      {/* Run Button */}
      <Button
        onClick={onExecute}
        disabled={isExecuting}
        size="sm"
        className="h-9 px-4"
      >
        <Play className="w-4 h-4 mr-1.5" />
        {isExecuting ? "Running..." : "Run"}
      </Button>
    </div>
  );
}
