/**
 * Oxy app tools for Alia.
 *
 * App definitions come from Oxy's signed capability-catalog registry. Each
 * execution asks Oxy for a short-lived capability ticket and sends that ticket
 * to the app; a user's persistent session token is never forwarded or stored.
 */

import { createHash, randomUUID } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z, type ZodTypeAny } from 'zod';
import { jsonSchemaToZod } from './mcp-schema.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { oxyServiceClient } from '../oxy-service-client.js';
import { TTLCache } from '../ttl-cache.js';

const TOOL_TIMEOUT_MS = 15_000;
const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');

const autonomySchema = z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']);
export type OxyToolAutonomy = z.infer<typeof autonomySchema>;

const resourceSchema = z.object({
  appId: z.string().min(1),
  effectiveAccountId: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
});
const catalogToolSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  capabilityPackage: z.string().min(1),
  requiredCapabilities: z.array(z.string()),
  resourceTypes: z.array(z.string()).min(1),
  effect: z.enum(['read', 'write', 'external', 'financial', 'security']),
  idempotency: z.enum(['none', 'supported', 'required']),
  rollback: z.enum(['none', 'manual', 'supported']),
  exposure: z.array(z.enum(['internal', 'mcp'])),
  invocation: z.object({
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    path: z.string().min(1),
  }),
});
const catalogSchema = z.object({
  schemaVersion: z.literal('1'),
  appId: z.string().min(1),
  version: z.string().min(1),
  audience: z.string().min(1),
  accountResourceType: z.string().min(1),
  tools: z.array(catalogToolSchema),
  events: z.array(z.unknown()),
});
const catalogsResponseSchema = z.object({
  registrations: z.array(z.object({ catalog: catalogSchema })),
});
const assignmentSchema = z.object({
  grantId: z.string().min(1),
  resource: resourceSchema,
  maximumAutonomy: autonomySchema,
  limits: z.array(z.object({ key: z.string(), value: z.unknown() })),
  toolNames: z.array(z.string()),
});
const mapResponseSchema = z.object({ assignments: z.array(assignmentSchema) });
const ticketResponseSchema = z.object({
  decision: z.object({ allowed: z.boolean(), reason: z.string() }).passthrough(),
  ticket: z.string().min(1).optional(),
});

type Catalog = z.infer<typeof catalogSchema>;
type CatalogTool = z.infer<typeof catalogToolSchema>;
type Resource = z.infer<typeof resourceSchema>;
type Actor =
  | { type: 'alia'; ownerAccountId: string }
  | { type: 'agent'; accountId: string };
type Assignment = z.infer<typeof assignmentSchema>;

export interface OxyToolExecutionContext {
  requesterAccountId: string;
  ownerAccountId: string;
  actor: Actor;
  runId?: string;
  autonomy?: OxyToolAutonomy;
}

interface CompiledTool {
  catalog: Catalog;
  definition: CatalogTool;
  inputSchema: ZodTypeAny;
}
interface CatalogDef {
  catalog: Catalog;
  displayName: string;
  compiledTools: CompiledTool[];
}
interface BoundTool {
  compiled: CompiledTool;
  resource: Resource;
  suffix: string | null;
}

const defsCache = new TTLCache<CatalogDef[]>({ ttlMs: 60_000, maxSize: 1 });
const contextCache = new TTLCache<string>({ ttlMs: 60_000, maxSize: 2_000 });
const DEFS_KEY = 'catalogs';

async function safeExecute(service: string, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error: unknown) {
    log.general.warn({ err: error, service }, 'Oxy capability tool error');
    return { error: `Could not access ${service}: ${getErrorMessage(error).slice(0, 180)}` };
  }
}

async function serviceToken(): Promise<string> {
  const client = oxyServiceClient();
  if (!client) throw new Error('Alia Oxy service credential is not configured');
  return client.getServiceToken();
}

async function oxyAuthorityFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await serviceToken();
  const response = await fetch(`${OXY_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Oxy authority error (${response.status}): ${(await response.text()).slice(0, 240)}`);
  }
  return response.json();
}

function appDisplayName(appId: string): string {
  return appId.length === 0 ? appId : `${appId.charAt(0).toUpperCase()}${appId.slice(1)}`;
}

async function loadCatalogDefs(): Promise<CatalogDef[]> {
  const parsed = catalogsResponseSchema.parse(await oxyAuthorityFetch('/capabilities/catalogs'));
  return parsed.registrations.map(({ catalog }) => ({
    catalog,
    displayName: appDisplayName(catalog.appId),
    compiledTools: catalog.tools
      .filter((definition) => definition.exposure.includes('internal'))
      .map((definition) => ({ catalog, definition, inputSchema: jsonSchemaToZod(definition.inputSchema) })),
  }));
}

function getCatalogDefs(): Promise<CatalogDef[]> {
  return defsCache.getOrLoad(DEFS_KEY, loadCatalogDefs);
}

async function agentAssignments(context: OxyToolExecutionContext): Promise<Assignment[]> {
  if (context.actor.type !== 'agent') return [];
  const parsed = mapResponseSchema.parse(await oxyAuthorityFetch('/capabilities/capability-map', {
    method: 'POST',
    body: JSON.stringify({
      requesterAccountId: context.requesterAccountId,
      ownerAccountId: context.ownerAccountId,
      actorAccountId: context.actor.accountId,
    }),
  }));
  return parsed.assignments;
}

/** Capability-only view used by the coordinator; it contains no app content. */
export async function getOxyAgentCapabilityMap(
  context: OxyToolExecutionContext,
): Promise<ReadonlyArray<{
  resource: Resource;
  maximumAutonomy: OxyToolAutonomy;
  limits: ReadonlyArray<{ key: string; value?: unknown }>;
  toolNames: readonly string[];
}>> {
  return agentAssignments(context);
}

function regularAliaBindings(defs: readonly CatalogDef[], context: OxyToolExecutionContext): BoundTool[] {
  const bindings: BoundTool[] = [];
  for (const service of defs) {
    for (const compiled of service.compiledTools) {
      if (!compiled.definition.resourceTypes.includes(compiled.catalog.accountResourceType)) continue;
      bindings.push({
        compiled,
        resource: {
          appId: compiled.catalog.appId,
          effectiveAccountId: context.requesterAccountId,
          resourceType: compiled.catalog.accountResourceType,
          resourceId: context.requesterAccountId,
        },
        suffix: null,
      });
    }
  }
  return bindings;
}

function agentBindings(defs: readonly CatalogDef[], assignments: readonly Assignment[]): BoundTool[] {
  const candidates: Array<{ compiled: CompiledTool; assignment: Assignment }> = [];
  for (const assignment of assignments) {
    const service = defs.find((entry) => entry.catalog.appId === assignment.resource.appId);
    if (!service) continue;
    for (const compiled of service.compiledTools) {
      if (assignment.toolNames.includes(compiled.definition.name)) candidates.push({ compiled, assignment });
    }
  }
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.compiled.catalog.appId}:${candidate.compiled.definition.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map(({ compiled, assignment }) => {
    const key = `${compiled.catalog.appId}:${compiled.definition.name}`;
    const digest = createHash('sha256').update([
      assignment.resource.resourceType,
      assignment.resource.resourceId,
      assignment.resource.effectiveAccountId,
    ].join(':')).digest('hex').slice(0, 8);
    return {
      compiled,
      resource: assignment.resource,
      suffix: (counts.get(key) ?? 0) > 1 ? digest : null,
    };
  });
}

function resolveInvocation(definition: CatalogTool, args: Record<string, unknown>): {
  url: URL;
  body: Record<string, unknown> | undefined;
} {
  const remaining = { ...args };
  const path = definition.invocation.path.replace(/\{(\w+)\}/g, (_match, parameter: string) => {
    const value = Object.hasOwn(remaining, parameter) ? remaining[parameter] : undefined;
    delete remaining[parameter];
    if (value === undefined || value === null) throw new Error(`Missing required path parameter: ${parameter}`);
    return encodeURIComponent(String(value));
  });
  const url = new URL(path, `${OXY_API_URL}/`);
  if (definition.invocation.method === 'GET') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return { url, body: undefined };
  }
  return { url, body: remaining };
}

async function issueTicket(
  context: OxyToolExecutionContext,
  resource: Resource,
  definition: CatalogTool,
  runId: string,
): Promise<string> {
  const requestedAutonomy: OxyToolAutonomy = definition.effect === 'read'
    ? 'read_only'
    : context.autonomy ?? 'execute_on_request';
  const parsed = ticketResponseSchema.parse(await oxyAuthorityFetch('/capabilities/tickets', {
    method: 'POST',
    body: JSON.stringify({
      requesterAccountId: context.requesterAccountId,
      ownerAccountId: context.ownerAccountId,
      actor: context.actor,
      resource,
      tool: definition.name,
      runId,
      requestedAutonomy,
      coordinatorMaximumAutonomy: context.autonomy ?? 'execute_on_request',
    }),
  }));
  if (!parsed.decision.allowed || !parsed.ticket) {
    throw new Error(`Oxy policy denied ${definition.name}: ${parsed.decision.reason}`);
  }
  return parsed.ticket;
}

async function callBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
): Promise<unknown> {
  const runId = context.runId ?? randomUUID();
  const capabilityTicket = await issueTicket(context, binding.resource, binding.compiled.definition, runId);
  const { url, body } = resolveInvocation(binding.compiled.definition, args);
  const headers: Record<string, string> = {
    authorization: `Capability ${capabilityTicket}`,
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';
  if (binding.compiled.definition.idempotency === 'required') {
    headers['idempotency-key'] = createHash('sha256')
      .update(`${runId}:${binding.compiled.definition.name}:${JSON.stringify(args)}`)
      .digest('hex');
  }
  const response = await fetch(url, {
    method: binding.compiled.definition.invocation.method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Oxy app error (${response.status}): ${(await response.text()).slice(0, 240)}`);
  return response.headers.get('content-type')?.includes('application/json')
    ? response.json()
    : response.text();
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function buildOxyServiceTools(
  oxyUserId: string,
  context: OxyToolExecutionContext,
  serviceIds?: readonly string[],
): Promise<ToolSet> {
  try {
    const allDefs = await getCatalogDefs();
    const allowed = serviceIds === undefined
      ? null
      : new Set(serviceIds.flatMap((id) => [id, id.replace(/^oxy-/, '')]));
    const defs = allowed
      ? allDefs.filter((entry) => allowed.has(entry.catalog.appId) || allowed.has(`oxy-${entry.catalog.appId}`))
      : allDefs;
    const bindings = context.actor.type === 'agent'
      ? agentBindings(defs, await agentAssignments(context))
      : regularAliaBindings(defs, context);
    const tools: ToolSet = {};
    for (const binding of bindings) {
      const baseName = `oxy_${sanitizeName(binding.compiled.catalog.appId)}__${sanitizeName(binding.compiled.definition.name)}`;
      const toolName = binding.suffix ? `${baseName}__${binding.suffix}` : baseName;
      tools[toolName] = tool({
        description: `[${appDisplayName(binding.compiled.catalog.appId)}] ${binding.compiled.definition.description} Resource: ${binding.resource.resourceType}/${binding.resource.resourceId}.`,
        inputSchema: binding.compiled.inputSchema,
        execute: async (args: Record<string, unknown>) => safeExecute(
          binding.compiled.catalog.appId,
          () => callBoundTool(binding, args, context),
        ),
      });
    }
    log.general.info({ userId: oxyUserId, toolCount: Object.keys(tools).length }, 'Oxy capability tools loaded');
    return tools;
  } catch (error: unknown) {
    log.general.error({ err: error, userId: oxyUserId }, 'Failed to load Oxy capability tools');
    return {};
  }
}

export async function getOxyServiceContext(userId: string, _accessToken: string): Promise<string> {
  const cached = contextCache.get(userId);
  if (cached !== undefined) return cached;
  const context: OxyToolExecutionContext = {
    requesterAccountId: userId,
    ownerAccountId: userId,
    actor: { type: 'alia', ownerAccountId: userId },
    autonomy: 'read_only',
  };
  try {
    const defs = await getCatalogDefs();
    const service = defs.find((entry) => entry.catalog.appId === 'inbox');
    const compiled = service?.compiledTools.find((entry) => entry.definition.name === 'getEmailContext');
    if (!compiled || !compiled.definition.resourceTypes.includes('email_account')) return '';
    const result = await callBoundTool({
      compiled,
      resource: { appId: 'inbox', effectiveAccountId: userId, resourceType: 'email_account', resourceId: userId },
      suffix: null,
    }, {}, context);
    const rendered = `\n\n## Connected Services Context\n- **Inbox**: ${JSON.stringify(result)}`;
    contextCache.set(userId, rendered);
    return rendered;
  } catch (error: unknown) {
    log.general.warn({ err: error }, 'Failed to fetch Oxy service context');
    return '';
  }
}

export function getOxyServicePromptFragment(_oxyUserId: string): string {
  const defs = defsCache.get(DEFS_KEY);
  if (!defs?.length) return '';
  const lines = defs.map((service) => {
    const names = service.compiledTools.map((entry) => `oxy_${sanitizeName(service.catalog.appId)}__${sanitizeName(entry.definition.name)}`);
    return `- **${service.displayName}**: ${names.join(', ')}. Access and autonomy are checked for every call.`;
  });
  return '\n\n## Connected Oxy Services\nUse the user or agent\'s delegated Oxy app capabilities through these tools.\n' + lines.join('\n');
}
