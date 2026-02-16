import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types';

// ============== REPLICATE ==============
// Replicate uses a predictions API (not OpenAI-compatible).
// Requires message-to-prompt conversion and SSE stream translation.

function convertMessagesToPrompt(messages: OpenAIMessage[]): { prompt: string; systemPrompt: string } {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      conversationParts.push(`User: ${text}`);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls) {
        const calls = msg.tool_calls.map((tc: any) => `[Called ${tc.function?.name}(${tc.function?.arguments})]`).join(' ');
        conversationParts.push(`Assistant: ${calls}`);
      } else {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        conversationParts.push(`Assistant: ${text}`);
      }
    } else if (msg.role === 'tool') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      conversationParts.push(`Tool (${msg.name || 'result'}): ${text}`);
    }
  }

  // End with "Assistant:" to prompt the model to respond
  conversationParts.push('Assistant:');

  return {
    prompt: conversationParts.join('\n'),
    systemPrompt: systemParts.join('\n'),
  };
}

function convertReplicateStreamToOpenAI(replicateStream: ReadableStream): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const reader = replicateStream.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          let currentEvent = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (currentEvent === 'output' && data) {
                const openaiChunk = {
                  id: 'chatcmpl-replicate',
                  object: 'chat.completion.chunk',
                  created: Date.now(),
                  model: 'replicate',
                  choices: [{
                    index: 0,
                    delta: { content: data },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
              } else if (currentEvent === 'done') {
                const openaiChunk = {
                  id: 'chatcmpl-replicate',
                  object: 'chat.completion.chunk',
                  created: Date.now(),
                  model: 'replicate',
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
              }
            }
          }
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export const replicateProvider: Provider = {
  name: 'Replicate',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = `https://api.replicate.com/v1/models/${key.modelId}/predictions`;

    const { prompt, systemPrompt } = convertMessagesToPrompt(messages);

    const input: any = {
      prompt,
      max_tokens: config?.maxTokens ?? 8192,
      temperature: config?.temperature ?? 0.7,
    };

    if (systemPrompt) {
      input.system_prompt = systemPrompt;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key.key}`,
      },
      body: JSON.stringify({ input, stream: true }),
    });

    if (!res.ok) {
      throw new Error(`Replicate ${res.status}: ${await res.text()}`);
    }

    return convertReplicateStreamToOpenAI(res.body!);
  },
};
