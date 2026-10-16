/**
 * Host tools: UI effects the embedding app performs on the person's screen
 * (Alia ADR 0020 §6, `docs/agent-embedding.md` §2).
 *
 * An app that embeds a conversation through `@alia.onl/sdk` declares, per
 * request, what its own client can do — open a listing, apply a search, switch
 * a view. The model sees each as `host_<app>__<name>`. Calling one does nothing
 * here: Alia records the call, emits `alia.host_action` to the client that
 * declared it, and tells the model the action was dispatched. The client
 * carries it out and sends the outcome with the NEXT request
 * (`host.outcomes`), which becomes that call's result — in the model's context
 * and in the stored conversation — so the model knows what actually happened.
 *
 * A host tool is never authority over data: the person's data is reached only
 * through their apps' catalogue tools, which Oxy authorizes per call. It is
 * also separate from the editor lane (`body.tools`), whose tools a developer
 * client executes and whose contract is unchanged.
 */
import { jsonObjectSchemaToZod } from '@oxy.so/mcp';
import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SSEEmitter } from './sse-emitter.js';

export const HOST_TOOL_OUTCOMES = ['applied', 'inline', 'rejected', 'stale', 'failed'] as const;
export type HostToolOutcome = (typeof HOST_TOOL_OUTCOMES)[number];

const MAX_HOST_TOOLS = 16;
const MAX_OUTCOMES = 32;

const hostToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    description: z.string().trim().min(1).max(1024),
    inputSchema: z
      .record(z.string(), z.unknown())
      .refine((schema) => schema.type === 'object', 'inputSchema must have an object root'),
  })
  .strict();

const hostOutcomeSchema = z
  .object({
    toolCallId: z.string().min(1).max(128),
    outcome: z.enum(HOST_TOOL_OUTCOMES),
    detail: z.string().max(500).optional(),
  })
  .strict();

export const hostRequestSchema = z
  .object({
    app: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    version: z.literal(1),
    tools: z.array(hostToolDefinitionSchema).max(MAX_HOST_TOOLS),
    outcomes: z.array(hostOutcomeSchema).max(MAX_OUTCOMES).optional(),
  })
  .strict()
  .superRefine((host, context) => {
    const names = new Set<string>();
    for (const [index, definition] of host.tools.entries()) {
      if (names.has(definition.name)) {
        context.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: `Duplicate host tool: ${definition.name}`,
        });
      }
      names.add(definition.name);
    }
  });

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostOutcome = z.infer<typeof hostOutcomeSchema>;

/** `undefined` when the request declared no host; an error message when it declared one badly. */
export function parseHostRequest(
  raw: unknown,
): { ok: true; host: HostRequest | undefined } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, host: undefined };
  const parsed = hostRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `Invalid host: ${issue ? `${issue.path.join('.') || 'host'}: ${issue.message}` : 'malformed'}`,
    };
  }
  for (const definition of parsed.data.tools) {
    try {
      jsonObjectSchemaToZod(definition.inputSchema);
    } catch {
      return { ok: false, message: `Invalid host: tools.${definition.name}.inputSchema` };
    }
  }
  return { ok: true, host: parsed.data };
}

export function hostToolName(app: string, name: string): string {
  return `host_${app.replace(/-/g, '_')}__${name}`;
}

/** The dispatched answer the model reads until the outcome arrives. */
export const HOST_TOOL_DISPATCHED = {
  status: 'dispatched',
  message:
    "The app is carrying this out on the person's screen. Its outcome arrives with their next message; do not claim it succeeded and do not repeat it.",
} as const;

/** One tool per declared host action, emitting `alia.host_action` when called. */
export function buildHostTools(host: HostRequest, emitter: SSEEmitter): ToolSet {
  const tools: ToolSet = {};
  for (const definition of host.tools) {
    const validator = jsonObjectSchemaToZod(definition.inputSchema);
    tools[hostToolName(host.app, definition.name)] = tool({
      description: `[In the app on the person's screen] ${definition.description}`,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema, {
        validate: (value) => {
          const parsed = validator.safeParse(value);
          return parsed.success
            ? { success: true, value: parsed.data as Record<string, unknown> }
            : { success: false, error: new Error('Input does not match the host tool schema') };
        },
      }),
      execute: async (input: Record<string, unknown>, { toolCallId }: { toolCallId: string }) => {
        emitter.emit('alia.host_action', {
          eventVersion: 1,
          toolCallId,
          app: host.app,
          name: definition.name,
          input,
        });
        return HOST_TOOL_DISPATCHED;
      },
    });
  }
  return tools;
}

/** What the model reads as a host call's result once the client reported it. */
export function hostOutcomeResult(outcome: HostOutcome): Record<string, unknown> {
  return {
    status: outcome.outcome,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * Replace each reported call's dispatched result with its outcome, in the
 * messages the model is about to read. A call the history does not contain is
 * ignored: an outcome is a fact about an earlier call, never a new one.
 */
export function applyHostOutcomes(
  messages: ModelMessage[],
  outcomes: readonly HostOutcome[] | undefined,
): ModelMessage[] {
  if (!outcomes?.length) return messages;
  const byCall = new Map(outcomes.map((outcome) => [outcome.toolCallId, outcome]));
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const outcome = byCall.get(part.toolCallId);
      if (!outcome) return part;
      changed = true;
      return {
        ...part,
        output: { type: 'text' as const, value: JSON.stringify(hostOutcomeResult(outcome)) },
      };
    });
    return changed ? { ...message, content } : message;
  });
}
