/**
 * Oxy Service Tools — Dynamic tools from registered Oxy ecosystem services
 *
 * Queries OxyService manifests and creates AI SDK tool() wrappers so the AI
 * can interact with Inbox (email), and future Oxy apps on the user's behalf.
 *
 * Auth: forwards the user's OxyHQ JWT — no OAuth needed for first-party services.
 *
 * Every tool execute() is wrapped with safeExecute() so that errors never
 * propagate — the AI always receives a structured { error } object it can
 * communicate naturally to the user.
 */

import { tool, type ToolSet } from 'ai';
import type { ZodTypeAny } from 'zod';
import { OxyService, type IOxyServiceTool, type IOxyServiceToolEndpoint } from '../../models/oxy-service.js';
import { jsonSchemaToZod } from './mcp-schema.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { TTLCache } from '../ttl-cache.js';

const TOOL_TIMEOUT_MS = 15_000;
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

// ---------------------------------------------------------------------------
// Safe execution wrapper — tools never throw, always return structured data
// ---------------------------------------------------------------------------

async function safeExecute(service: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: unknown) {
    log.general.warn({ err, service }, 'Oxy service tool error');
    return { error: `Could not access ${service}: ${getErrorMessage(err).slice(0, 150)}` };
  }
}

// ---------------------------------------------------------------------------
// Global service-definition cache
//
// OxyService manifests are user-independent (the query has no user filter), so
// the DB read + zod compilation — the expensive part — is cached ONCE globally.
// Per-request work (wrapping tools with the CURRENT access token, rendering the
// per-user context) is cheap and done fresh on top of these shared defs.
// ---------------------------------------------------------------------------

interface CompiledTool {
  toolName: string;
  displayName: string;
  description: string;
  inputSchema: ZodTypeAny;
  toolDef: IOxyServiceTool;
}

interface ServiceDef {
  serviceId: string;
  displayName: string;
  description: string;
  contextEndpoint?: string;
  toolNames: string[];
  hasConfirm: boolean;
  compiledTools: CompiledTool[];
}

const defsCache = new TTLCache<ServiceDef[]>({ ttlMs: 60_000, maxSize: 1 });
const contextCache = new TTLCache<string>({ ttlMs: 60_000, maxSize: 2000 });
const DEFS_KEY = 'defs';

async function loadServiceDefs(): Promise<ServiceDef[]> {
  const services = await OxyService.find({ status: 'active' }).lean();

  return services.map((svc) => {
    const prefix = `oxy_${sanitizeName(svc.serviceId)}`;
    const compiledTools: CompiledTool[] = svc.tools.map((svcTool) => ({
      toolName: `${prefix}__${sanitizeName(svcTool.name)}`,
      displayName: svc.displayName,
      description: svcTool.description,
      inputSchema: jsonSchemaToZod(svcTool.inputSchema),
      toolDef: svcTool,
    }));

    return {
      serviceId: svc.serviceId,
      displayName: svc.displayName,
      description: svc.description,
      contextEndpoint: svc.contextEndpoint,
      toolNames: compiledTools.map((t) => t.toolName),
      hasConfirm: svc.tools.some((t) => t.confirmBeforeExecute),
      compiledTools,
    };
  });
}

/** Load the shared service definitions (single-flight, 60s TTL). */
function getServiceDefs(): Promise<ServiceDef[]> {
  return defsCache.getOrLoad(DEFS_KEY, loadServiceDefs);
}

// ---------------------------------------------------------------------------
// HTTP caller — executes a tool's endpoint on behalf of the user
// ---------------------------------------------------------------------------

function resolveEndpointPath(
  endpoint: IOxyServiceToolEndpoint,
  args: Record<string, any>,
): { url: URL; remainingArgs: Record<string, any> } {
  const baseUrl = OXY_API_URL;
  let path = endpoint.path;

  // Clone args so we can remove consumed path params
  const remaining = { ...args };

  // Replace {param} placeholders with actual values
  const paramRegex = /\{(\w+)\}/g;
  path = path.replace(paramRegex, (_match, paramName) => {
    const value = remaining[paramName];
    delete remaining[paramName];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${paramName}`);
    }
    return encodeURIComponent(String(value));
  });

  const url = new URL(path, baseUrl);
  return { url, remainingArgs: remaining };
}

function applyQueryMapping(
  url: URL,
  args: Record<string, any>,
  queryMapping?: Record<string, string>,
): void {
  if (!queryMapping) return;
  for (const [toolParam, queryParam] of Object.entries(queryMapping)) {
    const value = args[toolParam];
    if (value !== undefined && value !== null) {
      url.searchParams.set(queryParam, String(value));
    }
  }
}

function buildRequestBody(
  args: Record<string, any>,
  bodyMapping?: Record<string, string>,
): Record<string, any> | undefined {
  if (!bodyMapping) return args;

  const body: Record<string, any> = {};
  for (const [toolParam, bodyField] of Object.entries(bodyMapping)) {
    const value = args[toolParam];
    if (value !== undefined) {
      body[bodyField] = value;
    }
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

function applyResultMapping(
  data: any,
  toolDef: IOxyServiceTool,
): any {
  if (!toolDef.resultMapping) return data;

  let result = data;

  // Extract a specific field
  if (toolDef.resultMapping.extract && result && typeof result === 'object') {
    result = result[toolDef.resultMapping.extract] ?? result;
  }

  // Summarize: keep only specified fields per item
  if (toolDef.resultMapping.summarize && Array.isArray(result)) {
    const fields = toolDef.resultMapping.summarize;
    result = result.map((item: any) => {
      if (typeof item !== 'object' || !item) return item;
      const summary: Record<string, any> = {};
      for (const field of fields) {
        // Support nested access with dot notation (e.g., "flags.seen")
        const parts = field.split('.');
        let val: any = item;
        for (const part of parts) {
          val = val?.[part];
        }
        if (val !== undefined) {
          summary[field] = val;
        }
      }
      return summary;
    });
  }

  // Per-tool truncation
  if (toolDef.resultMapping.maxChars && typeof result === 'string' && result.length > toolDef.resultMapping.maxChars) {
    result = result.slice(0, toolDef.resultMapping.maxChars) + '\n[truncated]';
  }

  return result;
}

async function callOxyService(
  toolDef: IOxyServiceTool,
  args: Record<string, any>,
  accessToken: string,
): Promise<any> {
  const { url, remainingArgs } = resolveEndpointPath(toolDef.endpoint, args);
  const method = toolDef.endpoint.method;

  if (method === 'GET') {
    // For GET, map remaining args to query params
    applyQueryMapping(url, remainingArgs, toolDef.endpoint.queryMapping);
    // Also add any remaining args not in the mapping directly as query params
    if (!toolDef.endpoint.queryMapping) {
      for (const [key, value] of Object.entries(remainingArgs)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  };

  if (method !== 'GET') {
    const body = buildRequestBody(remainingArgs, toolDef.endpoint.bodyMapping);
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API error (${response.status}): ${body.slice(0, 200)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  return applyResultMapping(data, toolDef);
}

// ---------------------------------------------------------------------------
// Tool builder — generates AI SDK tools from OxyService manifests
// ---------------------------------------------------------------------------

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function buildOxyServiceTools(
  oxyUserId: string,
  accessToken: string,
): Promise<ToolSet> {
  try {
    const defs = await getServiceDefs();

    // Wrap the shared (cached) tool defs FRESH with THIS caller's access token.
    // Closures are cheap to build; caching them per-user is what leaked the
    // first caller's token to later callers within the TTL window.
    const tools: ToolSet = {};
    for (const svc of defs) {
      for (const compiled of svc.compiledTools) {
        tools[compiled.toolName] = tool({
          description: `[${compiled.displayName}] ${compiled.description}`,
          inputSchema: compiled.inputSchema,
          execute: async (args: Record<string, unknown>) =>
            safeExecute(compiled.displayName, () =>
              callOxyService(compiled.toolDef, args as Record<string, any>, accessToken)),
        } as any);
      }
    }

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount, serviceCount: defs.length }, 'Oxy service tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load Oxy service tools');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Context provider — fetches context from each service's contextEndpoint
// ---------------------------------------------------------------------------

export async function getOxyServiceContext(
  userId: string,
  accessToken: string,
): Promise<string> {
  const cached = contextCache.get(userId);
  if (cached !== undefined) return cached;

  try {
    const defs = await getServiceDefs();
    const contextDefs = defs.filter(
      (d): d is ServiceDef & { contextEndpoint: string } => !!d.contextEndpoint,
    );

    if (contextDefs.length === 0) {
      contextCache.set(userId, '');
      return '';
    }

    const results = await Promise.allSettled(
      contextDefs.map(async (svc) => {
        const url = new URL(svc.contextEndpoint, OXY_API_URL);
        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(3_000), // Tight timeout — don't block chat
        });
        if (!response.ok) return null;
        const data = await response.json();
        return { service: svc.displayName, context: data };
      }),
    );

    const contextParts: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { service, context } = result.value;
        if (typeof context === 'string') {
          contextParts.push(`- **${service}**: ${context}`);
        } else if (typeof context === 'object' && context) {
          const summary = Object.entries(context)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          if (summary) {
            contextParts.push(`- **${service}**: ${summary}`);
          }
        }
      }
    }

    const rendered = contextParts.length > 0
      ? '\n\n## Connected Services Context\n' + contextParts.join('\n')
      : '';
    contextCache.set(userId, rendered);
    return rendered;
  } catch (err) {
    log.general.warn({ err }, 'Failed to fetch Oxy service context');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Prompt helper — builds a system prompt fragment for connected services
// ---------------------------------------------------------------------------

export function getOxyServicePromptFragment(_oxyUserId: string): string {
  // Reads the shared, user-independent defs snapshot. It is warm whenever any
  // request built tools/context in the last 60s (buildOxyServiceTools runs
  // before the system prompt in the request flow), so this stays sync.
  const defs = defsCache.get(DEFS_KEY);
  if (!defs || defs.length === 0) return '';

  const lines = defs.map((svc) => {
    let line = `- **${svc.displayName}**: ${svc.description}. Tools: ${svc.toolNames.join(', ')}.`;
    if (svc.hasConfirm) {
      line += ' ALWAYS confirm with the user before performing write actions.';
    }
    return line;
  });

  return '\n\n## Connected Oxy Services\nYou have access to the user\'s Oxy apps through tools prefixed with `oxy_`.\n' + lines.join('\n');
}
