import { createFileRoute } from '@tanstack/react-router';
import { useState, useRef, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Play01Icon,
  StopIcon,
  Delete02Icon,
  Copy01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useModelsStats } from '@/hooks/use-developer';
import { useApiKeys, useApps } from '@/hooks/use-developer';
import config from '@/lib/config';
import { toast } from 'sonner';

export const Route = createFileRoute('/_layout/playground')({
  component: PlaygroundPage,
});

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function PlaygroundPage() {
  const { data: modelsData, isLoading: modelsLoading } = useModelsStats();
  const { data: apps } = useApps();
  const firstApp = apps?.[0];
  const { data: apiKeys } = useApiKeys(firstApp?._id || '');

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful AI assistant.'
  );
  const [userInput, setUserInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [usage, setUsage] = useState<UsageStats | null>(null);

  // Settings state
  const [selectedModel, setSelectedModel] = useState('alia-lite');
  const [selectedApiKey, setSelectedApiKey] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [showSettings, setShowSettings] = useState(true);

  const abortControllerRef = useRef<AbortController | null>(null);

  const models = modelsData?.models ?? [];

  const handleSend = useCallback(async () => {
    if (!userInput.trim() || isStreaming) return;

    const apiKey = selectedApiKey || apiKeys?.[0]?.keyPrefix;
    if (!apiKey) {
      toast.error('No API key available. Create one in the Apps section.');
      return;
    }

    const newMessages: Message[] = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...messages,
      { role: 'user' as const, content: userInput.trim() },
    ];

    setMessages([...messages, { role: 'user', content: userInput.trim() }]);
    setUserInput('');
    setIsStreaming(true);
    setStreamingContent('');
    setUsage(null);

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(`${config.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: newMessages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Request failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                assistantContent += content;
                setStreamingContent(assistantContent);
              }
              if (parsed.usage) {
                setUsage(parsed.usage);
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: assistantContent },
      ]);
      setStreamingContent('');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        toast.info('Request cancelled');
      } else {
        toast.error((error as Error).message || 'Failed to send message');
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }, [
    userInput,
    isStreaming,
    messages,
    systemPrompt,
    selectedModel,
    selectedApiKey,
    apiKeys,
    temperature,
    maxTokens,
  ]);

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  const handleClear = () => {
    setMessages([]);
    setStreamingContent('');
    setUsage(null);
  };

  const handleCopyResponse = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Playground</h1>
          <p className="text-sm text-muted-foreground">
            Test the API with different models and parameters
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleClear}>
            <HugeiconsIcon icon={Delete02Icon} size={14} className="mr-1.5" />
            Clear
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
          >
            <HugeiconsIcon icon={Settings01Icon} size={14} className="mr-1.5" />
            Settings
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Settings Panel */}
        <Collapsible open={showSettings} onOpenChange={setShowSettings}>
          <CollapsibleContent className="h-full">
            <div className="w-72 border-r border-border h-full overflow-y-auto p-4 space-y-6">
              {/* Model Selection */}
              <div className="space-y-2">
                <Label>Model</Label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsLoading ? (
                      <SelectItem value="loading" disabled>
                        Loading...
                      </SelectItem>
                    ) : (
                      models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <div className="flex items-center gap-2">
                            <span>{model.name}</span>
                            <Badge variant="secondary" className="text-xs">
                              {model.tier}
                            </Badge>
                          </div>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* API Key Selection */}
              <div className="space-y-2">
                <Label>API Key</Label>
                <Select value={selectedApiKey} onValueChange={setSelectedApiKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select API key" />
                  </SelectTrigger>
                  <SelectContent>
                    {apiKeys?.map((key) => (
                      <SelectItem key={key._id} value={key.keyPrefix}>
                        <span className="font-mono text-xs">{key.keyPrefix}...</span>
                        <span className="ml-2 text-muted-foreground">{key.name}</span>
                      </SelectItem>
                    )) || (
                      <SelectItem value="none" disabled>
                        No API keys
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {!apiKeys?.length && (
                  <p className="text-xs text-muted-foreground">
                    Create an app and API key first
                  </p>
                )}
              </div>

              <Separator />

              {/* System Prompt */}
              <div className="space-y-2">
                <Label>System Prompt</Label>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Instructions for the AI..."
                  rows={4}
                  className="resize-none text-sm"
                />
              </div>

              <Separator />

              {/* Temperature */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Temperature</Label>
                  <span className="text-sm text-muted-foreground">{temperature}</span>
                </div>
                <Input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full h-2"
                />
                <p className="text-xs text-muted-foreground">
                  Lower = more focused, higher = more creative
                </p>
              </div>

              {/* Max Tokens */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Max Tokens</Label>
                  <span className="text-sm text-muted-foreground">{maxTokens}</span>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="4096"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                  className="w-full"
                />
              </div>

              {/* Usage Stats */}
              {usage && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <Label>Token Usage</Label>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="p-2 rounded-lg bg-muted">
                        <p className="text-lg font-semibold">{usage.prompt_tokens}</p>
                        <p className="text-xs text-muted-foreground">Prompt</p>
                      </div>
                      <div className="p-2 rounded-lg bg-muted">
                        <p className="text-lg font-semibold">{usage.completion_tokens}</p>
                        <p className="text-xs text-muted-foreground">Completion</p>
                      </div>
                      <div className="p-2 rounded-lg bg-muted">
                        <p className="text-lg font-semibold">{usage.total_tokens}</p>
                        <p className="text-xs text-muted-foreground">Total</p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Chat Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 max-w-3xl mx-auto">
              {messages.length === 0 && !streamingContent && (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-sm">Send a message to start the conversation</p>
                </div>
              )}

              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                      {message.role === 'assistant' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => handleCopyResponse(message.content)}
                        >
                          <HugeiconsIcon icon={Copy01Icon} size={12} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {streamingContent && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg p-3 bg-muted">
                    <p className="text-sm whitespace-pre-wrap">
                      {streamingContent}
                      <span className="animate-pulse">▊</span>
                    </p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input Area */}
          <div className="border-t border-border p-4 shrink-0">
            <div className="max-w-3xl mx-auto flex gap-2">
              <Textarea
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                rows={2}
                className="resize-none flex-1"
                disabled={isStreaming}
              />
              {isStreaming ? (
                <Button
                  variant="destructive"
                  size="icon"
                  className="h-auto"
                  onClick={handleStop}
                >
                  <HugeiconsIcon icon={StopIcon} size={20} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="h-auto"
                  onClick={handleSend}
                  disabled={!userInput.trim()}
                >
                  <HugeiconsIcon icon={Play01Icon} size={20} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
