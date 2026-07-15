/**
 * Message Converter — converts OpenAI-format messages to AI SDK ModelMessage format.
 *
 * Handles:
 *   - System, user, assistant messages
 *   - Multi-part content (text + images)
 *   - Tool calls (OpenAI format from editors + Alia toolInvocations format)
 *   - Tool results (role "tool" in OpenAI format)
 *   - Tool name mapping (sanitized names for Google Gemini compatibility)
 */

/** Minimal type for OpenAI-format chat messages from request body */
export interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  toolInvocations?: Array<{ toolCallId: string; toolName: string; state: string; args?: unknown; result?: unknown }>;
}

/**
 * Convert OpenAI-format messages to AI SDK ModelMessage format.
 * Handles tool result messages which have role "tool" in OpenAI format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK ModelMessage types are complex/dynamic
export function convertToAISDKMessages(messages: ChatMessage[], toolNameMapping: Map<string, string>): any[] {
  const result: any[] = [];
  const toolCallsMap = new Map<string, { name: string; index: number }>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: msg.content || ''
      });
    } else if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // Multi-part content (text + images): convert OpenAI image_url format to AI SDK image format
        result.push({
          role: 'user',
          content: (msg.content as Array<{ type: string; image_url?: { url: string } }>).map(part => {
            if (part.type === 'image_url' && part.image_url?.url) {
              return { type: 'image', image: part.image_url.url };
            }
            return part;
          }),
        });
      } else {
        result.push({
          role: 'user',
          content: msg.content
        });
      }
    } else if (msg.role === 'assistant') {
      // Support both formats:
      // - tool_calls: OpenAI/editor format (from Cursor, VS Code, etc.)
      // - toolInvocations: Alia app format (from mobile/web app)
      let toolCalls = msg.tool_calls;
      if (!toolCalls && msg.toolInvocations && Array.isArray(msg.toolInvocations) && msg.toolInvocations.length > 0) {
        toolCalls = msg.toolInvocations!.map(inv => ({
          id: inv.toolCallId,
          type: 'function',
          function: {
            name: inv.toolName,
            arguments: JSON.stringify(inv.args || {}),
          },
        }));
      }

      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Track tool calls for matching with results
        for (const tc of toolCalls) {
          if (tc.id && tc.function?.name) {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]: [string, string]) => orig === tc.function.name)?.[0] || tc.function.name;
            toolCallsMap.set(tc.id, { name: sanitizedName, index: result.length });
          }
        }

        result.push({
          role: 'assistant',
          content: msg.content || '',
          toolCalls: toolCalls.map((tc: { id: string; function?: { name: string; arguments: string } }) => {
            const sanitizedName = Array.from(toolNameMapping.entries())
              .find(([_, orig]: [string, string]) => orig === tc.function?.name)?.[0] || tc.function?.name || 'unknown';

            return {
              toolCallId: tc.id,
              toolName: sanitizedName,
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {})
            };
          })
        });

        // For toolInvocations with results, also push corresponding tool result messages
        // (These are already resolved — the app stores the tool output inline)
        if (msg.toolInvocations && Array.isArray(msg.toolInvocations)) {
          for (const inv of msg.toolInvocations) {
            if (inv.state === 'result' && inv.result !== undefined) {
              const resultValue = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result);
              result.push({
                role: 'tool',
                content: [{
                  type: 'tool-result',
                  toolCallId: inv.toolCallId,
                  toolName: inv.toolName,
                  output: {
                    type: 'text',
                    value: resultValue,
                  },
                }],
              });
            }
          }
        }
      } else {
        result.push({
          role: 'assistant',
          content: msg.content || ''
        });
      }
    } else if (msg.role === 'tool') {
      // Convert OpenAI tool result to AI SDK format
      const toolCallId = msg.tool_call_id ?? '';
      const toolInfo = toolCallsMap.get(toolCallId);
      let toolName = toolInfo?.name || msg.name || 'unknown';

      // Try to find tool name from previous assistant message if unknown
      if (toolName === 'unknown' && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const matchingCall = prevMsg.tool_calls!.find(tc => tc.id === toolCallId);
            if (matchingCall) {
              toolName = matchingCall.function?.name || 'unknown';
              break;
            }
          }
        }
      }

      const contentValue = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      result.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: toolCallId,
          toolName: toolName,
          output: {
            type: 'text',
            value: contentValue
          }
        }]
      });
    }
  }

  return result;
}
