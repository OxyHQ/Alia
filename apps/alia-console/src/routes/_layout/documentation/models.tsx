import { createFileRoute, Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/_layout/documentation/models')({
  component: ModelsDocPage,
});

const models = [
  {
    id: 'alia-lite',
    name: 'Alia Lite',
    description: 'Fast and efficient for simple tasks',
    tier: 'Free',
    contextWindow: '8K',
    maxOutput: '2K',
    features: ['Fast response time', 'Low cost', 'Basic reasoning'],
    useCases: ['Simple Q&A', 'Text formatting', 'Quick lookups'],
  },
  {
    id: 'alia-v1',
    name: 'Alia V1',
    description: 'Balanced performance and quality for everyday use',
    tier: 'Free',
    contextWindow: '32K',
    maxOutput: '8K',
    features: ['Balanced performance', 'Good reasoning', 'Multilingual support'],
    useCases: ['General conversation', 'Content creation', 'Code assistance'],
  },
  {
    id: 'alia-v1-pro',
    name: 'Alia V1 Pro',
    description: 'Advanced reasoning capabilities for complex tasks',
    tier: 'Pro',
    contextWindow: '128K',
    maxOutput: '16K',
    features: ['Advanced reasoning', 'Extended context', 'Better accuracy'],
    useCases: ['Complex analysis', 'Long documents', 'Research tasks'],
  },
  {
    id: 'alia-v1-pro-max',
    name: 'Alia V1 Pro Max',
    description: 'Maximum performance and context for demanding applications',
    tier: 'Pro',
    contextWindow: '200K',
    maxOutput: '32K',
    features: ['Maximum performance', 'Largest context', 'Best accuracy'],
    useCases: ['Enterprise applications', 'Large codebases', 'Complex reasoning'],
  },
];

function ModelsDocPage() {
  return (
    <div className="flex-1 bg-background max-w-4xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/documentation"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Documentation
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Available models and their capabilities
        </p>
      </div>

      {/* Overview */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Overview</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Alia offers a range of models optimized for different use cases. All models are
          accessible through the same API endpoint - just change the model parameter.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">{models.length}</p>
            <p className="text-xs text-muted-foreground">Models</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">200K</p>
            <p className="text-xs text-muted-foreground">Max Context</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">2</p>
            <p className="text-xs text-muted-foreground">Free Models</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">2</p>
            <p className="text-xs text-muted-foreground">Pro Models</p>
          </div>
        </div>
      </div>

      {/* Model List */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Available Models</h2>
        <div className="space-y-4">
          {models.map((model) => (
            <Card key={model.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {model.name}
                      <Badge
                        variant={model.tier === 'Pro' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {model.tier}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="mt-1">{model.description}</CardDescription>
                  </div>
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                    {model.id}
                  </code>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Context Window</p>
                    <p className="text-sm font-medium">{model.contextWindow}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Max Output</p>
                    <p className="text-sm font-medium">{model.maxOutput}</p>
                  </div>
                </div>
                <div className="mb-3">
                  <p className="text-xs text-muted-foreground mb-2">Features</p>
                  <div className="flex flex-wrap gap-1.5">
                    {model.features.map((feature) => (
                      <Badge key={feature} variant="outline" className="text-xs">
                        {feature}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Best for</p>
                  <div className="flex flex-wrap gap-1.5">
                    {model.useCases.map((useCase) => (
                      <span
                        key={useCase}
                        className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded"
                      >
                        {useCase}
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Choosing a Model</h2>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">For quick tasks</h3>
            <p className="text-sm text-muted-foreground mb-2">
              Use <code className="text-xs bg-muted px-1 py-0.5 rounded">alia-lite</code> for
              simple, fast responses where speed is more important than depth.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">For general use</h3>
            <p className="text-sm text-muted-foreground mb-2">
              Use <code className="text-xs bg-muted px-1 py-0.5 rounded">alia-v1</code> for
              most applications - it offers a great balance of quality and cost.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">For complex tasks</h3>
            <p className="text-sm text-muted-foreground mb-2">
              Use <code className="text-xs bg-muted px-1 py-0.5 rounded">alia-v1-pro</code> or{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">alia-v1-pro-max</code> for
              tasks requiring advanced reasoning or large context windows.
            </p>
          </div>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/models"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">View model statistics</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
