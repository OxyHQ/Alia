/**
 * Server-Sent Events (SSE) Streaming Handler
 *
 * Provides improved streaming with metadata, events, and proper error handling.
 * NEVER exposes provider information to clients!
 */

import type { Response } from 'express';
import { type AliaError, toSSEError } from './errors';

// ============== SSE EVENT TYPES ==============

export type SSEEventType =
  | 'metadata'      // Initial metadata about the request
  | 'chunk'         // Content chunks
  | 'thinking'      // For thinking models, show reasoning process
  | 'tool_call'     // Tool/function call events
  | 'tool_result'   // Tool results
  | 'fallback'      // Fallback to different model
  | 'cache_hit'     // Response from cache
  | 'cost'          // Cost information
  | 'done'          // Stream complete
  | 'error'         // Error occurred
  | 'directive';    // Directive (model switch, retry, rate limited)

export type DirectiveType = 'switch_model' | 'retry' | 'rate_limited';

export interface SSEMetadata {
  model: string;              // ONLY Alia model name!
  requestId: string;
  cached: boolean;
  estimatedCost?: number;
  maxTokens: number;
}

export interface SSEChunk {
  content: string;
  index: number;
  finishReason?: 'stop' | 'length' | 'tool_calls' | null;
}

export interface SSECost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;               // USD
  cached: boolean;
}

export interface SSEError {
  code: string;
  message: string;            // User-safe message (no provider names!)
  retryable: boolean;
  retryAfter?: number;
}

// ============== SSE STREAM CLASS ==============

export class SSEStream {
  private res: Response;
  private connected: boolean = false;
  private chunkIndex: number = 0;
  private startTime: number;

  constructor(res: Response) {
    this.res = res;
    this.startTime = Date.now();
    this.setupConnection();
  }

  /**
   * Setup SSE connection headers
   */
  private setupConnection(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    this.res.flushHeaders();
    this.connected = true;

    // Send initial comment to establish connection
    this.writeRaw(': connected\n\n');
  }

  /**
   * Write raw SSE data
   */
  private writeRaw(data: string): void {
    if (!this.connected) return;
    this.res.write(data);
  }

  /**
   * Send an SSE event
   */
  private sendEvent(event: SSEEventType, data: any): void {
    if (!this.connected) return;

    const lines = [
      `event: ${event}`,
      `data: ${JSON.stringify(data)}`,
      '', // Empty line to complete event
      ''  // Extra newline for separation
    ];

    this.writeRaw(lines.join('\n'));
  }

  /**
   * Send metadata at start of stream
   */
  sendMetadata(metadata: SSEMetadata): void {
    this.sendEvent('metadata', {
      ...metadata,
      timestamp: new Date().toISOString(),
      streamId: `${Date.now()}-${Math.random().toString(36).substring(7)}`
    });
  }

  /**
   * Send content chunk
   */
  sendChunk(content: string, finishReason: SSEChunk['finishReason'] = null): void {
    this.sendEvent('chunk', {
      content,
      index: this.chunkIndex++,
      finishReason,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send thinking/reasoning text (for thinking models)
   */
  sendThinking(thinking: string): void {
    this.sendEvent('thinking', {
      content: thinking,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send tool call event
   */
  sendToolCall(toolName: string, toolArgs: any, toolCallId: string): void {
    this.sendEvent('tool_call', {
      tool: toolName,
      arguments: toolArgs,
      callId: toolCallId,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send tool result
   */
  sendToolResult(toolCallId: string, result: any): void {
    this.sendEvent('tool_result', {
      callId: toolCallId,
      result,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send fallback notification (when switching providers)
   * IMPORTANT: Message must not expose provider names!
   */
  sendFallback(reason: string = 'high demand'): void {
    this.sendEvent('fallback', {
      message: `Using backup model due to ${reason}...`,
      timestamp: Date.now() - this.startTime
      // NEVER include: actual provider names or model IDs!
    });
  }

  /**
   * Send cache hit notification
   */
  sendCacheHit(savedCost: number, savedTokens: number): void {
    this.sendEvent('cache_hit', {
      message: 'Response retrieved from cache',
      savedCost,
      savedTokens,
      instantResponse: true
    });
  }

  /**
   * Send cost information
   */
  sendCost(cost: SSECost): void {
    this.sendEvent('cost', {
      ...cost,
      costPerToken: cost.totalTokens > 0 ? cost.cost / cost.totalTokens : 0,
      duration: Date.now() - this.startTime
    });
  }

  /**
   * Send error event
   * CRITICAL: Error must be sanitized (no provider names!)
   */
  sendError(error: SSEError): void {
    this.sendEvent('error', {
      ...error,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send an AliaError as an SSE error event.
   * Convenience method that converts AliaError to SSEError shape automatically.
   * The user-facing message from AliaError is used (never exposes provider names).
   */
  sendAliaError(error: AliaError): void {
    this.sendError(toSSEError(error));
  }

  /**
   * Send a directive event to the client.
   * Used to notify about model switches, retries, or rate limiting during streaming.
   * IMPORTANT: Messages must NEVER expose provider names!
   */
  sendDirective(type: DirectiveType, message: string): void {
    this.sendEvent('directive', {
      directive: type,
      message,
      timestamp: Date.now() - this.startTime
    });
  }

  /**
   * Send stream completion event
   */
  sendDone(finalStats?: Partial<SSECost>): void {
    this.sendEvent('done', {
      message: 'Stream complete',
      duration: Date.now() - this.startTime,
      ...finalStats
    });
  }

  /**
   * Close the stream
   */
  close(): void {
    if (!this.connected) return;
    this.writeRaw('event: done\ndata: {}\n\n');
    this.res.end();
    this.connected = false;
  }

  /**
   * Check if still connected
   */
  isConnected(): boolean {
    return this.connected && !this.res.writableEnded;
  }
}

// ============== HELPER FUNCTIONS ==============

/**
 * Convert provider stream to SSE stream
 * Wraps a provider's ReadableStream and converts to SSE format
 */
export async function streamProviderResponseAsSSE(
  sseStream: SSEStream,
  providerStream: ReadableStream,
  metadata: {
    aliasModelId: string;
    fromCache: boolean;
    estimatedCost: number;
  }
): Promise<{
  inputTokens: number;
  outputTokens: number;
  success: boolean;
}> {
  const reader = providerStream.getReader();
  const decoder = new TextDecoder();

  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = '';

  try {
    // Send initial metadata
    sseStream.sendMetadata({
      model: metadata.aliasModelId,  // ONLY Alia model!
      requestId: `req_${Date.now()}`,
      cached: metadata.fromCache,
      estimatedCost: metadata.estimatedCost,
      maxTokens: 8192
    });

    // If from cache, notify and return immediately
    if (metadata.fromCache) {
      sseStream.sendCacheHit(metadata.estimatedCost, 0);
    }

    // Stream chunks
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Parse SSE from provider
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(data);

            // Extract content from OpenAI-format response
            if (parsed.choices?.[0]?.delta?.content) {
              const content = parsed.choices[0].delta.content;
              sseStream.sendChunk(content);
              outputTokens += 1; // Approximate
            }

            // Handle tool calls
            if (parsed.choices?.[0]?.delta?.tool_calls) {
              const toolCall = parsed.choices[0].delta.tool_calls[0];
              if (toolCall?.function?.name) {
                sseStream.sendToolCall(
                  toolCall.function.name,
                  JSON.parse(toolCall.function.arguments || '{}'),
                  toolCall.id
                );
              }
            }

            // Handle finish
            if (parsed.choices?.[0]?.finish_reason) {
              sseStream.sendChunk('', parsed.choices[0].finish_reason);
            }

            // Track usage if provided
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || 0;
              outputTokens = parsed.usage.completion_tokens || 0;
            }
          } catch {
            // Invalid JSON - skip
            console.warn('[SSEStream] Failed to parse chunk:', data);
          }
        }
      }
    }

    return {
      inputTokens,
      outputTokens,
      success: true
    };
  } catch (error) {
    console.error('[SSEStream] Error streaming:', error);
    return {
      inputTokens,
      outputTokens,
      success: false
    };
  }
}

/**
 * Create a simple SSE stream for cached responses
 */
export async function streamCachedResponse(
  sseStream: SSEStream,
  cachedResponse: any,
  metadata: {
    aliasModelId: string;
    tokensUsed: number;
    savedCost: number;
  }
): Promise<void> {
  // Send metadata
  sseStream.sendMetadata({
    model: metadata.aliasModelId,
    requestId: `req_${Date.now()}`,
    cached: true,
    estimatedCost: 0,
    maxTokens: 8192
  });

  // Notify cache hit
  sseStream.sendCacheHit(metadata.savedCost, metadata.tokensUsed);

  // Stream the cached content
  const content = cachedResponse.choices?.[0]?.message?.content || '';

  // Split into chunks for smooth streaming effect
  const chunkSize = 50;
  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    sseStream.sendChunk(chunk);
    await new Promise(resolve => setTimeout(resolve, 10)); // Small delay for visual effect
  }

  // Send final chunk with finish reason
  sseStream.sendChunk('', 'stop');

  // Send cost (zero for cached)
  sseStream.sendCost({
    inputTokens: metadata.tokensUsed,
    outputTokens: 0,
    totalTokens: metadata.tokensUsed,
    cost: 0,
    cached: true
  });

  // Done
  sseStream.sendDone({
    totalTokens: metadata.tokensUsed,
    cost: 0,
    cached: true
  });
}

// ============== KEEP-ALIVE ==============

/**
 * Setup keep-alive for long-running streams
 * Sends comment every 30s to prevent timeouts
 */
export function setupKeepAlive(sseStream: SSEStream): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (sseStream.isConnected()) {
      sseStream['writeRaw'](': keepalive\n\n');
    }
  }, 30000); // Every 30 seconds
}
