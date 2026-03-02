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
import { OxyService, type IOxyServiceTool, type IOxyServiceToolEndpoint } from '../../models/oxy-service.js';
import { jsonSchemaToZod } from './mcp-schema.js';
import { log } from '../logger.js';

const TOOL_TIMEOUT_MS = 15_000;
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

// ---------------------------------------------------------------------------
// Safe execution wrapper — tools never throw, always return structured data
// ---------------------------------------------------------------------------

async function safeExecute(service: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: any) {
    log.general.warn({ err, service }, 'Oxy service tool error');
    return { error: `Could not access ${service}: ${err.message?.slice(0, 150) || 'unknown error'}` };
  }
}

// ---------------------------------------------------------------------------
// Short-lived cache (same pattern as MCP & integration tools)
// ---------------------------------------------------------------------------

const cache = new Map<string, { tools: ToolSet; services: Array<{ serviceId: string; displayName: string; description: string; contextEndpoint?: string }>; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

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
  const cacheKey = oxyUserId;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  const tools: ToolSet = {};

  try {
    const services = await OxyService.find({ status: 'active' }).lean();

    if (services.length === 0) {
      cache.set(cacheKey, { tools, services: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return tools;
    }

    const serviceMeta: typeof cached extends undefined ? never : NonNullable<typeof cached>['services'] = [];

    for (const svc of services) {
      const prefix = `oxy_${sanitizeName(svc.serviceId)}`;
      serviceMeta.push({
        serviceId: svc.serviceId,
        displayName: svc.displayName,
        description: svc.description,
        contextEndpoint: svc.contextEndpoint,
      });

      for (const svcTool of svc.tools) {
        const toolName = `${prefix}__${sanitizeName(svcTool.name)}`;

        tools[toolName] = tool({
          description: `[${svc.displayName}] ${svcTool.description}`,
          parameters: jsonSchemaToZod(svcTool.inputSchema),
          execute: async (args: Record<string, unknown>) =>
            safeExecute(svc.displayName, () => callOxyService(svcTool, args as Record<string, any>, accessToken)),
        } as any);
      }
    }

    cache.set(cacheKey, { tools, services: serviceMeta, expiresAt: Date.now() + CACHE_TTL_MS });

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount, serviceCount: services.length }, 'Oxy service tools loaded');
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
  accessToken: string,
): Promise<string> {
  try {
    const services = await OxyService.find({
      status: 'active',
      contextEndpoint: { $exists: true, $ne: null },
    })
      .select('serviceId displayName contextEndpoint')
      .lean();

    if (services.length === 0) return '';

    const results = await Promise.allSettled(
      services.map(async (svc) => {
        const url = new URL(svc.contextEndpoint!, OXY_API_URL);
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

    return contextParts.length > 0
      ? '\n\n## Connected Services Context\n' + contextParts.join('\n')
      : '';
  } catch (err) {
    log.general.warn({ err }, 'Failed to fetch Oxy service context');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Prompt helper — builds a system prompt fragment for connected services
// ---------------------------------------------------------------------------

export async function getOxyServicePromptFragment(): Promise<string> {
  try {
    const services = await OxyService.find({ status: 'active' })
      .select('serviceId displayName description tools')
      .lean();

    if (services.length === 0) return '';

    const lines = services.map((svc) => {
      const toolNames = svc.tools.map((t) => t.name).join(', ');
      const hasConfirm = svc.tools.some((t) => t.confirmBeforeExecute);
      let line = `- **${svc.displayName}**: ${svc.description}. Tools: ${toolNames}.`;
      if (hasConfirm) {
        line += ' ALWAYS confirm with the user before performing write actions.';
      }
      return line;
    });

    return '\n\n## Connected Oxy Services\nYou have access to the user\'s Oxy apps through tools prefixed with `oxy_`.\n' + lines.join('\n');
  } catch {
    return '';
  }
}
