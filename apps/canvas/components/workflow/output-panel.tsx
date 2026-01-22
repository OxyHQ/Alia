"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { WorkflowExecution } from "@/lib/workflow-types";

interface OutputPanelProps {
  execution: WorkflowExecution | null;
  isExecuting: boolean;
  onClose: () => void;
}

export function OutputPanel({ execution, isExecuting, onClose }: OutputPanelProps) {
  return (
    <div className="w-96 border-l bg-card flex flex-col">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold">Output</h2>
        <Button onClick={onClose} variant="ghost" size="sm">
          Close
        </Button>
      </div>

      <ScrollArea className="flex-1 p-4">
        {isExecuting && !execution && (
          <div className="text-center py-8 text-muted-foreground">
            Running workflow...
          </div>
        )}

        {execution && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">Status</div>
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
            </div>

            {execution.results.length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">Results</div>
                <div className="space-y-2">
                  {execution.results.map((result, index) => (
                    <div key={index} className="border rounded p-2 text-sm">
                      <div className="font-medium text-xs text-muted-foreground mb-1">
                        {result.nodeType} ({result.nodeId})
                      </div>
                      {result.error ? (
                        <div className="text-red-600 dark:text-red-400">{result.error}</div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words">
                          {JSON.stringify(result.output, null, 2)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-sm font-medium mb-2">Final Output</div>
              <div className="border rounded p-3 bg-muted/50">
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {execution.finalOutput}
                </pre>
              </div>
            </div>
          </div>
        )}

        {!execution && !isExecuting && (
          <div className="text-center py-8 text-muted-foreground">
            Run the workflow to see output
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
