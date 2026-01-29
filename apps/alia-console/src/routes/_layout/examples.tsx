import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, CheckmarkCircle01Icon } from '@hugeicons/core-free-icons';

export const Route = createFileRoute('/_layout/examples')({
  component: ExamplesPage,
});

const examples = {
  javascript: `const response = await fetch('https://api.alia.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer alia_sk_YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'alia-v1',
    messages: [
      { role: 'user', content: 'Hello!' }
    ],
  }),
});

const data = await response.json();
console.log(data.choices[0].message.content);`,

  python: `import openai

client = openai.OpenAI(
    api_key="alia_sk_YOUR_API_KEY",
    base_url="https://api.alia.ai/v1"
)

response = client.chat.completions.create(
    model="alia-v1",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)`,

  nodejs: `import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'alia_sk_YOUR_API_KEY',
  baseURL: 'https://api.alia.ai/v1',
});

const completion = await openai.chat.completions.create({
  model: 'alia-v1',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(completion.choices[0].message.content);`,

  curl: `curl https://api.alia.ai/v1/chat/completions \\
  -H "Authorization: Bearer alia_sk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`,

  streaming: `const response = await fetch('https://api.alia.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer alia_sk_YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'alia-v1',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true,
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\\n').filter(line => line.startsWith('data: '));

  for (const line of lines) {
    const data = JSON.parse(line.slice(6));
    if (data.choices[0].delta.content) {
      process.stdout.write(data.choices[0].delta.content);
    }
  }
}`,
};

type ExampleKey = keyof typeof examples;

const tabs: { value: ExampleKey; label: string }[] = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'nodejs', label: 'Node.js' },
  { value: 'curl', label: 'cURL' },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2"
        onClick={handleCopy}
      >
        <HugeiconsIcon
          icon={copied ? CheckmarkCircle01Icon : Copy01Icon}
          size={16}
          className={copied ? 'text-green-500' : ''}
        />
      </Button>
      <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ExamplesPage() {
  const [activeTab, setActiveTab] = useState<ExampleKey>('javascript');

  return (
    <div className="flex-1 bg-background max-w-4xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Code Examples</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Example code for integrating with the Alia API
        </p>
      </div>

      {/* Basic Chat Completion */}
      <div className="px-6 py-6 border-b border-border">
        <p className="text-sm font-semibold text-foreground mb-1">Basic Chat Completion</p>
        <p className="text-sm text-muted-foreground mb-4">
          Make a simple chat completion request
        </p>

        {/* Language Tabs */}
        <div className="flex gap-1 mb-4">
          {tabs.map((tab) => (
            <Button
              key={tab.value}
              variant={activeTab === tab.value ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        <CodeBlock code={examples[activeTab]} />
      </div>

      {/* Streaming Response */}
      <div className="px-6 py-6">
        <p className="text-sm font-semibold text-foreground mb-1">Streaming Response</p>
        <p className="text-sm text-muted-foreground mb-4">
          Stream responses for real-time output
        </p>
        <CodeBlock code={examples.streaming} />
      </div>
    </div>
  );
}
