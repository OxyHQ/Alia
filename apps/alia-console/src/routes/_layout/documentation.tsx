import { createFileRoute, Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';

export const Route = createFileRoute('/_layout/documentation')({
  component: DocumentationPage,
});

function DocumentationPage() {
  const models = [
    { id: 'alia-lite', description: 'Fast and efficient for simple tasks', tier: 'Free' },
    { id: 'alia-v1', description: 'Balanced performance and quality', tier: 'Free' },
    { id: 'alia-v1-pro', description: 'Advanced reasoning capabilities', tier: 'Pro' },
    { id: 'alia-v1-pro-max', description: 'Maximum performance and context', tier: 'Pro' },
  ];

  return (
    <div className="flex-1 bg-background max-w-4xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">API Documentation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Learn how to integrate with the Alia API
        </p>
      </div>

      {/* Quick Start */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Quick start</p>

        <div className="space-y-6">
          <div>
            <p className="text-sm font-medium text-foreground mb-2">1. Create an API Key</p>
            <p className="text-sm text-muted-foreground">
              Go to the API Keys section and create a new API key for your application.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground mb-2">2. Make Your First Request</p>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
              {`curl https://api.alia.ai/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}
            </pre>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground mb-2">3. Handle the Response</p>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
              {`{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "alia-v1",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}`}
            </pre>
          </div>
        </div>
      </div>

      {/* Authentication */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Authentication</p>
        <p className="text-sm text-muted-foreground mb-3">
          All API requests require authentication using a Bearer token in the Authorization header:
        </p>
        <pre className="bg-muted p-4 rounded-lg text-sm">
          Authorization: Bearer alia_sk_YOUR_API_KEY
        </pre>
        <p className="text-xs text-muted-foreground mt-3">
          Keep your API key secure and never expose it in client-side code.
        </p>
      </div>

      {/* Available Models */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-4">Available models</p>
        <div>
          {models.map((model, index) => (
            <div
              key={model.id}
              className={`flex items-center justify-between py-3 ${
                index < models.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div>
                <p className="text-sm font-mono text-foreground">{model.id}</p>
                <p className="text-xs text-muted-foreground">{model.description}</p>
              </div>
              <span className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
                {model.tier}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Links */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-4">Resources</p>
        <div>
          <Link
            to="/examples"
            className="flex items-center justify-between py-3 border-b border-border hover:opacity-70 transition-opacity"
          >
            <p className="text-sm text-foreground">View code examples</p>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/models"
            className="flex items-center justify-between py-3 hover:opacity-70 transition-opacity"
          >
            <p className="text-sm text-foreground">Model statistics</p>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
