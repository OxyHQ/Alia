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
import type { Workflow } from "@/lib/workflow-types";

interface LoadWorkflowDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLoad: (id: string) => void;
}

export function LoadWorkflowDialog({ isOpen, onClose, onLoad }: LoadWorkflowDialogProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadWorkflows();
    }
  }, [isOpen]);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const response = await fetch(`${API_URL}/api/workflows`);
      const data = await response.json();
      if (response.ok) {
        setWorkflows(data.workflows || []);
      }
    } catch (error) {
      console.error("Failed to load workflows:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Load Workflow</DialogTitle>
          <DialogDescription>
            Select a workflow to load
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading workflows...</div>
          ) : workflows.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No saved workflows</div>
          ) : (
            workflows.map((workflow) => (
              <div
                key={workflow.id}
                className="p-4 border rounded-lg hover:bg-accent cursor-pointer transition-colors"
                onClick={() => onLoad(workflow.id)}
              >
                <div className="font-medium">{workflow.name}</div>
                <div className="text-sm text-muted-foreground">
                  {new Date(workflow.updatedAt).toLocaleDateString()}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
