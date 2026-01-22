"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { WorkflowNode } from "@/lib/workflow-types";
import { MODELS } from "@/lib/models";

interface NodeEditPanelProps {
  node: WorkflowNode;
  onUpdate: (nodeId: string, data: Partial<WorkflowNode["data"]>) => void;
  onClose: () => void;
}

export function NodeEditPanel({ node, onUpdate, onClose }: NodeEditPanelProps) {
  const handleChange = (field: string, value: unknown) => {
    onUpdate(node.id, { [field]: value });
  };

  return (
    <div className="w-96 border-l bg-card flex flex-col">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold">Edit Node</h2>
        <Button onClick={onClose} variant="ghost" size="sm">
          Close
        </Button>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          <div>
            <Label>Node Type</Label>
            <div className="text-sm text-muted-foreground capitalize">{node.type}</div>
          </div>

          <div>
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={node.data.label || ""}
              onChange={(e) => handleChange("label", e.target.value)}
            />
          </div>

          {/* AI Text Node */}
          {node.type === "aiText" && (
            <>
              <div>
                <Label htmlFor="model">Model</Label>
                <Select
                  value={node.data.model || "alia-v1-lite"}
                  onValueChange={(value) => handleChange("model", value)}
                >
                  <SelectTrigger id="model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex flex-col">
                          <span className="font-medium">{model.name}</span>
                          <span className="text-xs text-muted-foreground">{model.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="prompt">Prompt</Label>
                <Textarea
                  id="prompt"
                  value={node.data.prompt || ""}
                  onChange={(e) => handleChange("prompt", e.target.value)}
                  rows={4}
                />
              </div>

              <div>
                <Label htmlFor="systemPrompt">System Prompt</Label>
                <Textarea
                  id="systemPrompt"
                  value={node.data.systemPrompt || ""}
                  onChange={(e) => handleChange("systemPrompt", e.target.value)}
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="temperature">Temperature</Label>
                <Input
                  id="temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={node.data.temperature || 0.7}
                  onChange={(e) => handleChange("temperature", parseFloat(e.target.value))}
                />
              </div>
            </>
          )}

          {/* AI Image Node */}
          {node.type === "aiImage" && (
            <>
              <div>
                <Label htmlFor="model">Model</Label>
                <Select
                  value={node.data.model || "alia-v1-lite"}
                  onValueChange={(value) => handleChange("model", value)}
                >
                  <SelectTrigger id="model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex flex-col">
                          <span className="font-medium">{model.name}</span>
                          <span className="text-xs text-muted-foreground">{model.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="prompt">Prompt</Label>
                <Textarea
                  id="prompt"
                  value={node.data.prompt || ""}
                  onChange={(e) => handleChange("prompt", e.target.value)}
                  rows={4}
                />
              </div>

              <div>
                <Label htmlFor="size">Size</Label>
                <Select
                  value={node.data.size || "1024x1024"}
                  onValueChange={(value) => handleChange("size", value)}
                >
                  <SelectTrigger id="size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="256x256">256x256</SelectItem>
                    <SelectItem value="512x512">512x512</SelectItem>
                    <SelectItem value="1024x1024">1024x1024</SelectItem>
                    <SelectItem value="1792x1024">1792x1024</SelectItem>
                    <SelectItem value="1024x1792">1024x1792</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* GitHub Node */}
          {node.type === "github" && (
            <>
              <div>
                <Label htmlFor="githubUrl">GitHub URL</Label>
                <Input
                  id="githubUrl"
                  value={node.data.githubUrl || ""}
                  onChange={(e) => handleChange("githubUrl", e.target.value)}
                  placeholder="https://github.com/user/repo"
                />
              </div>

              <div>
                <Label htmlFor="branch">Branch</Label>
                <Input
                  id="branch"
                  value={node.data.branch || "main"}
                  onChange={(e) => handleChange("branch", e.target.value)}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="fetchReadme">Fetch README</Label>
                <Switch
                  id="fetchReadme"
                  checked={node.data.fetchReadme || false}
                  onCheckedChange={(checked) => handleChange("fetchReadme", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="fetchStructure">Fetch Structure</Label>
                <Switch
                  id="fetchStructure"
                  checked={node.data.fetchStructure || false}
                  onCheckedChange={(checked) => handleChange("fetchStructure", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="fetchKeyFiles">Fetch Key Files</Label>
                <Switch
                  id="fetchKeyFiles"
                  checked={node.data.fetchKeyFiles || false}
                  onCheckedChange={(checked) => handleChange("fetchKeyFiles", checked)}
                />
              </div>
            </>
          )}

          {/* Text Input Node */}
          {node.type === "textInput" && (
            <div>
              <Label htmlFor="text">Text</Label>
              <Textarea
                id="text"
                value={node.data.text || ""}
                onChange={(e) => handleChange("text", e.target.value)}
                rows={6}
              />
            </div>
          )}

          {/* Output Node */}
          {node.type === "output" && (
            <>
              <div>
                <Label htmlFor="outputType">Output Type</Label>
                <Select
                  value={node.data.outputType || "readme-md"}
                  onValueChange={(value) => handleChange("outputType", value)}
                >
                  <SelectTrigger id="outputType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="readme-md">README.md</SelectItem>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="customFilename">Custom Filename</Label>
                <Input
                  id="customFilename"
                  value={node.data.customFilename || ""}
                  onChange={(e) => handleChange("customFilename", e.target.value)}
                />
              </div>
            </>
          )}

          {/* Merge Node */}
          {node.type === "merge" && (
            <div>
              <Label htmlFor="separator">Separator</Label>
              <Input
                id="separator"
                value={node.data.separator || "\n\n"}
                onChange={(e) => handleChange("separator", e.target.value)}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
