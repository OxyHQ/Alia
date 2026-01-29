import { createFileRoute, Link } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import {
  EnvironmentVariables,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
  EnvironmentVariablesContent,
  EnvironmentVariable,
} from '@/components/ui/environment-variables';
import { useState } from 'react';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/documentation/quickstart')({
  component: QuickStartPage,
});

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          className={`size-4 ${copied ? 'text-green-500' : ''}`}
        />
      </Button>
    </div>
  );
}

function QuickStartPage() {
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
        <h1 className="text-2xl font-semibold text-foreground">Quick Start</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Get up and running with the Alia API in minutes
        </p>
      </div>

      {/* Step 1 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            1
          </span>
          <h2 className="text-lg font-semibold text-foreground">Create an API Key</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          First, you'll need to create an API key to authenticate your requests.
          Go to the <Link to="/apps" className="text-primary hover:underline">API Keys</Link> section
          to create a new application and generate an API key.
        </p>
        <EnvironmentVariables className="max-w-md">
          <EnvironmentVariablesHeader>
            <EnvironmentVariablesTitle>Your API Key</EnvironmentVariablesTitle>
            <EnvironmentVariablesToggle />
          </EnvironmentVariablesHeader>
          <EnvironmentVariablesContent>
            <EnvironmentVariable name="ALIA_API_KEY" value="alia_sk_your_api_key_here" />
          </EnvironmentVariablesContent>
        </EnvironmentVariables>
      </div>

      {/* Step 2 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            2
          </span>
          <h2 className="text-lg font-semibold text-foreground">Install the SDK (Optional)</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          The Alia API is compatible with OpenAI's SDK. You can use any OpenAI-compatible library:
        </p>
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Node.js / JavaScript</p>
            <CodeBlock code="npm install openai" />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Python</p>
            <CodeBlock code="pip install openai" />
          </div>
        </div>
      </div>

      {/* Step 3 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            3
          </span>
          <h2 className="text-lg font-semibold text-foreground">Make Your First Request</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Here's a simple example using cURL:
        </p>
        <CodeBlock
          code={`curl https://api.alia.onl/v1/chat/completions \\
  -H "Authorization: Bearer $ALIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}
        />
      </div>

      {/* Step 4 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            4
          </span>
          <h2 className="text-lg font-semibold text-foreground">Handle the Response</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          You'll receive a response like this:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "id": "chatcmpl-abc123",
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
        />
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/authentication"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Learn about authentication</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Explore Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/examples"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">View code examples</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
