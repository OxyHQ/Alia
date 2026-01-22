"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { WorkflowExecution } from "@/lib/workflow-types";

interface RunHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string | null;
  onSelectRun: (output: string) => void;
}

export function RunHistoryDialog({
  isOpen,
  onClose,
  workflowId,
  onSelectRun,
}: RunHistoryDialogProps) {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && workflowId) {
      loadHistory();
    }
  }, [isOpen, workflowId]);

  const loadHistory = async () => {
    if (!workflowId) return;

    setLoading(true);
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const response = await fetch(`${API_URL}/api/workflows/${workflowId}/executions`);
      const data = await response.json();
      if (response.ok) {
        setExecutions(data.executions || []);
      }
    } catch (error) {
      console.error("Failed to load execution history:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run History</DialogTitle>
          <DialogDescription>
            View previous workflow executions
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading history...</div>
          ) : !workflowId ? (
            <div className="text-center py-8 text-muted-foreground">
              Save the workflow first to view history
            </div>
          ) : executions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No execution history</div>
          ) : (
            executions.map((execution) => (
              <div
                key={execution.id}
                className="p-4 border rounded-lg hover:bg-accent cursor-pointer transition-colors"
                onClick={() => {
                  onSelectRun(execution.finalOutput);
                  onClose();
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div
                    className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                      execution.status === "completed"
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
                        : execution.status === "failed"
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100"
                          : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100"
                    }`}
                  >
                    {execution.status}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(execution.startedAt).toLocaleString()}
                  </div>
                </div>
                <div className="text-sm line-clamp-2">{execution.finalOutput}</div>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
