import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { WorkflowNode } from "@/lib/workflow-types";
import type { Edge } from "@xyflow/react";

interface TemplatesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (nodes: WorkflowNode[], edges: Edge[], name: string) => void;
}

export function TemplatesDialog({ isOpen, onClose, onSelectTemplate }: TemplatesDialogProps) {
  const templates = [
    {
      id: "readme-generator",
      name: "README Generator",
      description: "Generate a comprehensive README from a GitHub repository",
    },
    {
      id: "code-explainer",
      name: "Code Explainer",
      description: "Explain code from a GitHub repository",
    },
    {
      id: "documentation-writer",
      name: "Documentation Writer",
      description: "Generate documentation for a codebase",
    },
  ];

  const loadTemplate = (templateId: string) => {
    // Template definitions would be implemented here
    // For now, returning empty arrays as placeholder
    const nodes: WorkflowNode[] = [];
    const edges: Edge[] = [];
    const template = templates.find((t) => t.id === templateId);
    onSelectTemplate(nodes, edges, template?.name || "Template");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workflow Templates</DialogTitle>
          <DialogDescription>
            Choose a template to get started quickly
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {templates.map((template) => (
            <div
              key={template.id}
              className="p-4 border rounded-lg hover:bg-accent cursor-pointer transition-colors"
              onClick={() => loadTemplate(template.id)}
            >
              <div className="font-medium">{template.name}</div>
              <div className="text-sm text-muted-foreground">{template.description}</div>
            </div>
          ))}
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
