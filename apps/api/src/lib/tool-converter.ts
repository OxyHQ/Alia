/**
 * Tool Converter
 *
 * Converts between OpenAI tool format and AI SDK ToolSet format.
 * Handles provider-specific constraints (e.g., Google's function name requirements).
 */

import { tool } from 'ai';
import { z } from 'zod';

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
 * Convert JSON Schema to Zod schema.
 * Handles common JSON Schema types used in OpenAI function calling.
 */
function jsonSchemaToZod(schema: Record<string, any> | undefined): z.ZodTypeAny {
  if (!schema || Object.keys(schema).length === 0) {
    return z.object({}).passthrough();
  }

  // Handle based on type
  const type = schema.type;

  if (type === 'object') {
    const properties = schema.properties || {};
    const required = schema.required || [];

    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let zodProp = jsonSchemaToZod(propSchema as Record<string, any>);

      // Add description if present
      if ((propSchema as any).description) {
        zodProp = zodProp.describe((propSchema as any).description);
      }

      // Make optional if not required
      if (!required.includes(key)) {
        zodProp = zodProp.optional();
      }

      shape[key] = zodProp;
    }

    // Use passthrough to allow additional properties (common in editor tools)
    return z.object(shape).passthrough();
  }

  if (type === 'string') {
    if (schema.enum) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    return z.string();
  }

  if (type === 'number' || type === 'integer') {
    return z.number();
  }

  if (type === 'boolean') {
    return z.boolean();
  }

  if (type === 'array') {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    return z.array(itemSchema);
  }

  if (type === 'null') {
    return z.null();
  }

  // Union types (anyOf, oneOf)
  if (schema.anyOf || schema.oneOf) {
    const schemas = (schema.anyOf || schema.oneOf) as Record<string, any>[];
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return jsonSchemaToZod(schemas[0]);
    return z.union([
      jsonSchemaToZod(schemas[0]),
      jsonSchemaToZod(schemas[1]),
      ...schemas.slice(2).map(s => jsonSchemaToZod(s))
    ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  // Fallback: accept any
  return z.any();
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
    // Use 'as any' to bypass strict typing since schemas are dynamic
    const zodSchema = jsonSchemaToZod(t.function.parameters);

    toolSet[sanitizedName] = tool({
      description: t.function.description || `Tool: ${originalName}`,
      parameters: zodSchema,
      execute: async (params: Record<string, unknown>) => {
        // Return params for client-side execution
        // The actual tool execution happens on the client (Cursor/VS Code)
        return {
          _originalToolName: originalName,
          _sanitizedToolName: sanitizedName,
          params,
        };
      },
    } as any);
  }

  return toolSet;
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
