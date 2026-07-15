/**
 * JSON Schema to Zod converter — shared utility
 *
 * Used by tool-converter.ts (OpenAI tools) and mcp.ts (MCP tools).
 */

import { z } from 'zod';

const MAX_DEPTH = 20;

/**
 * Convert JSON Schema to Zod schema.
 * Handles common types used in MCP and OpenAI function calling.
 * Includes recursion depth guard for untrusted schemas.
 */
export function jsonSchemaToZod(schema: Record<string, any> | undefined, depth = 0): z.ZodTypeAny {
  if (depth > MAX_DEPTH) return z.any();
  if (!schema || Object.keys(schema).length === 0) return z.object({}).passthrough();

  const type = schema.type;

  if (type === 'object') {
    const properties = schema.properties || {};
    const required: string[] = schema.required || [];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let zodProp = jsonSchemaToZod(propSchema as Record<string, any>, depth + 1);

      const description: unknown = (propSchema as { description?: unknown } | null | undefined)?.description;
      if (typeof description === 'string') {
        zodProp = zodProp.describe(description);
      }

      if (!required.includes(key)) {
        zodProp = zodProp.optional();
      }

      shape[key] = zodProp;
    }

    return z.object(shape).passthrough();
  }

  if (type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    return z.string();
  }

  if (type === 'number' || type === 'integer') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'null') return z.null();

  if (type === 'array') {
    const itemSchema = schema.items ? jsonSchemaToZod(schema.items, depth + 1) : z.any();
    return z.array(itemSchema);
  }

  // Union types (anyOf, oneOf)
  const unionSchemas = schema.anyOf || schema.oneOf;
  if (Array.isArray(unionSchemas)) {
    if (unionSchemas.length === 0) return z.any();
    if (unionSchemas.length === 1) return jsonSchemaToZod(unionSchemas[0], depth + 1);
    return z.union([
      jsonSchemaToZod(unionSchemas[0], depth + 1),
      jsonSchemaToZod(unionSchemas[1], depth + 1),
      ...unionSchemas.slice(2).map(s => jsonSchemaToZod(s, depth + 1)),
    ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  return z.any();
}
