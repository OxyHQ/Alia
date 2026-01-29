import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HugeiconsIcon } from '@hugeicons/react';
import { CheckmarkCircle01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import { useModelsStats } from '@/hooks/use-developer';

export const Route = createFileRoute('/_layout/models')({
  component: ModelsPage,
});

function ModelsPage() {
  const { data: modelsData, isLoading } = useModelsStats();

  const models = modelsData?.models ?? [];

  return (
    <ScrollArea className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Model statistics and performance metrics
        </p>
      </div>

      {/* Models List */}
      <div className="px-6">
        {isLoading ? (
          <div className="animate-pulse space-y-6 py-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-3">
                <div className="h-5 w-32 bg-muted rounded" />
                <div className="h-4 w-48 bg-muted rounded" />
                <div className="flex gap-8">
                  <div className="h-8 w-16 bg-muted rounded" />
                  <div className="h-8 w-16 bg-muted rounded" />
                  <div className="h-8 w-16 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : models.length > 0 ? (
          models.map((model, index) => (
            <div
              key={model.id}
              className={`py-6 ${index < models.length - 1 ? 'border-b border-border' : ''}`}
            >
              {/* Model Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-2 h-2 rounded-full ${model.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
                  />
                  <div>
                    <p className="text-sm font-medium text-foreground">{model.name}</p>
                    <p className="text-xs font-mono text-muted-foreground">{model.id}</p>
                  </div>
                </div>
                <Badge
                  variant={
                    model.tier === 'lite'
                      ? 'secondary'
                      : model.tier === 'standard'
                        ? 'default'
                        : 'outline'
                  }
                >
                  {model.tier}
                </Badge>
              </div>

              <p className="text-sm text-muted-foreground mb-4">{model.description}</p>

              {/* Stats */}
              <div className="flex flex-row gap-8 mb-4">
                <div>
                  <p className="text-sm font-medium text-foreground">{model.avgLatencyMs}ms</p>
                  <p className="text-xs text-muted-foreground">Latency</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{model.uptime}%</p>
                  <p className="text-xs text-muted-foreground">Uptime</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{model.successRate}%</p>
                  <p className="text-xs text-muted-foreground">Success</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{model.creditMultiplier}x</p>
                  <p className="text-xs text-muted-foreground">Credits</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {model.maxTokens.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">Max tokens</p>
                </div>
              </div>

              {/* Features */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-sm">
                  <HugeiconsIcon
                    icon={model.supportsTools ? CheckmarkCircle01Icon : Cancel01Icon}
                    size={14}
                    className={model.supportsTools ? 'text-green-500' : 'text-muted-foreground'}
                  />
                  <span
                    className={model.supportsTools ? 'text-foreground' : 'text-muted-foreground'}
                  >
                    Tools
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-sm">
                  <HugeiconsIcon
                    icon={model.supportsVision ? CheckmarkCircle01Icon : Cancel01Icon}
                    size={14}
                    className={model.supportsVision ? 'text-green-500' : 'text-muted-foreground'}
                  />
                  <span
                    className={model.supportsVision ? 'text-foreground' : 'text-muted-foreground'}
                  >
                    Vision
                  </span>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No model data available
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
