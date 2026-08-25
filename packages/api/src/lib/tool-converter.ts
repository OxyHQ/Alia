/**
 * Tool Converter
 *
 * Converts between OpenAI tool format and AI SDK ToolSet format.
 * Handles provider-specific constraints (e.g., Google's function name requirements).
 */

import { asSchema, tool, type ToolSet } from 'ai';
import { jsonSchemaToZod } from './tools/mcp-schema.js';

/**
 * OpenAI tool format (as received from clients like Cursor)
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

/**
 * Sanitize function name for provider compatibility.
 * Google Gemini requires: start with letter/underscore, alphanumeric + _.-: only, max 64 chars.
 */
export function sanitizeFunctionName(name: string): string {
  // Replace invalid characters with underscores
  let sanitized = name.replace(/[^a-zA-Z0-9_.\-:]/g, '_');

  // Ensure starts with letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = '_' + sanitized;
  }

  // Truncate to 64 chars
  return sanitized.slice(0, 64);
}

/**
 * Convert OpenAI-format tools array to AI SDK ToolSet.
 *
 * Input format (OpenAI):
 * [{ type: "function", function: { name, description, parameters } }]
 *
 * Output format (AI SDK):
 * { toolName: tool({ description, parameters, execute }) }
 *
 * @param openAITools - Array of OpenAI-format tool definitions
 * @param nameMapping - Optional map to track original names (sanitized -> original)
 * @returns AI SDK ToolSet
 */
export function convertOpenAIToolsToToolSet(
  openAITools: OpenAITool[],
  nameMapping?: Map<string, string>
): Record<string, any> {
  const toolSet: Record<string, any> = {};

  for (const t of openAITools) {
    if (t.type !== 'function' || !t.function) continue;

    const originalName = t.function.name;
    const sanitizedName = sanitizeFunctionName(originalName);

    // Track name mapping if provided
    if (nameMapping) {
      nameMapping.set(sanitizedName, originalName);
    }

    // Create tool with dynamic schema from OpenAI format
    const zodSchema = jsonSchemaToZod(t.function.parameters);

    toolSet[sanitizedName] = tool({
      description: t.function.description || `Tool: ${originalName}`,
      inputSchema: zodSchema,
      execute: async (params: Record<string, unknown>) => {
        // Return params for client-side execution
        // The actual tool execution happens on the client (Cursor/VS Code)
        return {
          _originalToolName: originalName,
          _sanitizedToolName: sanitizedName,
          params,
        };
      },
    });
  }

  return toolSet;
}

/**
 * The OTHER direction: a `ToolSet` the assembler built, as OpenAI descriptors.
 *
 * Needed by any surface that speaks the OpenAI function format rather than the
 * AI SDK's — `routes/v1/voice.ts` is the one, because a realtime voice session
 * is configured with `tools: [{ type: 'function', function: … }]`.
 *
 * It exists so that surface can stop writing its tools out by hand. A
 * hand-written list is an ASSEMBLER: it decides what a session may reach, and
 * once a session can belong to an agent that decision is a permission the
 * capability grants were supposed to own. Converting the assembler's output
 * means the grants are applied once, where they are defined.
 *
 * ## The schema is the tool's own, resolved rather than reconstructed
 *
 * `asSchema(...).jsonSchema` is the AI SDK's own resolution of a tool's input
 * schema — the same value it would send a provider — so what a voice session
 * advertises cannot drift from what the tool actually accepts. Rebuilding the
 * shape by hand is what the six descriptors in `voice.ts` were.
 *
 * `asSchema` rather than `zodSchema`, and the difference is load-bearing:
 * `inputSchema` is a `FlexibleSchema`, so a tool built from a JSON Schema —
 * every MCP and Oxy-service tool is — carries an already-resolved schema that
 * `zodSchema` refuses. `asSchema` accepts both, which is what makes this work
 * for a set the assembler built rather than only for hand-written tools.
 *
 * Async because that resolution is: `jsonSchema` is a promise on the SDK's
 * schema object, and awaiting it once per session is cheaper than the round
 * trips this replaces.
 *
 * A tool with no resolvable schema is emitted with an EMPTY object schema
 * rather than dropped. A provider that receives no `parameters` treats the
 * function as taking none, which is true of `getCurrentDate`; dropping it would
 * silently shorten the set instead.
 */
export async function convertToolSetToOpenAITools(tools: ToolSet): Promise<OpenAITool[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, definition]) => {
      const parameters = (await asSchema(definition.inputSchema).jsonSchema) as Record<
        string,
        unknown
      >;
      return {
        type: 'function' as const,
        function: {
          name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          parameters,
        },
      };
    }),
  );
}

/**
 * Convert AI SDK tool call back to OpenAI format for response streaming.
 *
 * @param toolCallId - The tool call ID
 * @param sanitizedName - The sanitized tool name used in the request
 * @param originalName - The original tool name to return to client
 * @param args - The tool call arguments
 */
export function formatToolCallForOpenAI(
  toolCallId: string,
  toolName: string,
  args: Record<string, any>,
  nameMapping?: Map<string, string>
) {
  // Restore original name if we have a mapping
  const originalName = nameMapping?.get(toolName) || toolName;

  return {
    index: 0,
    id: toolCallId,
    type: 'function' as const,
    function: {
      name: originalName,
      arguments: JSON.stringify(args),
    },
  };
}
