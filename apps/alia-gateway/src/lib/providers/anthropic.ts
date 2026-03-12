import type { KeyConfig, OpenAIMessage, OpenAITool, Provider, ProviderConfig } from '../types.js';

// ============== ANTHROPIC ==============
// Anthropic Claude models - requires conversion from OpenAI to Anthropic format
export const anthropicProvider: Provider = {
  name: 'Anthropic',

  isEnabled: () => true,

  async proxy(key: KeyConfig, messages: OpenAIMessage[], tools?: OpenAITool[], config?: ProviderConfig): Promise<ReadableStream> {
    const url = 'https://api.anthropic.com/v1/messages';

    // Convert OpenAI messages to Anthropic format
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const anthropicMessages = nonSystemMessages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        // Convert tool calls to Anthropic format
        return {
          role: 'assistant',
          content: msg.tool_calls.map((tc: any) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments)
          }))
        };
      } else if (msg.role === 'tool') {
        // Convert tool results to Anthropic format
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }]
        };
      } else {
        return {
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        };
      }
    });

    // Convert OpenAI tools to Anthropic format
    const anthropicTools = tools?.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} }
    }));

    const body: any = {
      model: key.modelId,
      messages: anthropicMessages,
      max_tokens: config?.maxTokens ?? 8192,
      temperature: config?.temperature ?? 0.7,
      stream: true
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map(m => m.content).join('\n');
    }

    if (anthropicTools?.length) {
      body.tools = anthropicTools;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key.key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }

    // Convert Anthropic streaming format to OpenAI format
    return convertAnthropicStreamToOpenAI(res.body!);
  }
};

// Helper function to convert Anthropic SSE stream to OpenAI format
function convertAnthropicStreamToOpenAI(anthropicStream: ReadableStream): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const reader = anthropicStream.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);

                // Convert Anthropic events to OpenAI format
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  const openaiChunk = {
                    id: parsed.id || 'chatcmpl-anthropic',
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: 'claude',
                    choices: [{
                      index: 0,
                      delta: { content: parsed.delta.text },
                      finish_reason: null
                    }]
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                } else if (parsed.type === 'message_stop') {
                  const openaiChunk = {
                    id: 'chatcmpl-anthropic',
                    object: 'chat.completion.chunk',
                    created: Date.now(),
                    model: 'claude',
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop'
                    }]
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                }
              } catch (e) {
                // Ignore JSON parse errors
              }
            }
          }
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}
