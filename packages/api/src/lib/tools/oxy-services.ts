/**
 * Oxy app tools for Alia.
 *
 * App definitions come from Oxy's signed capability-catalog registry. Each
 * execution asks Oxy for a short-lived capability ticket and sends that ticket
 * to the app; a user's persistent session token is never forwarded or stored.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appCapabilityCatalogSchema,
  capabilityCatalogBindingSchema,
  canonicalCapabilityJson,
  type CapabilityCatalogBinding,
  autonomyLevelSchema,
  resourceRefSchema,
  type ActorRef,
  type AppCapabilityCatalog,
  type AutonomyLevel,
  type CatalogTool,
  type ResourceRef,
} from '@oxy.so/contracts';
import { tool, type ToolSet } from 'ai';
import { createInternalCatalogMcpClient } from '@oxy.so/mcp';
import { z, type ZodTypeAny } from 'zod';
import { jsonSchemaToZod } from './mcp-schema.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { declareReadOnly } from '../agent/tool-effects.js';
import {
  createOxyExecutionAuthorization,
  revokeOxyExecutionAuthorization,
} from '../oxy-capability-authority.js';
import { oxyServiceClient, oxyServiceToken } from '../oxy-service-client.js';
import { TTLCache } from '../ttl-cache.js';

const TOOL_TIMEOUT_MS = 15_000;
const INTERNAL_MCP_PILOT = process.env.ALIA_INTERNAL_MCP_PILOT;
if (INTERNAL_MCP_PILOT !== undefined && INTERNAL_MCP_PILOT !== 'mention') {
  throw new Error('ALIA_INTERNAL_MCP_PILOT must name the explicit Mention pilot');
}
function agency() {
  const client = oxyServiceClient();
  if (!client) throw new OxyAuthorityUnavailableError('Alia service identity is unavailable');
  return client.agency;
}
const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');

export type OxyToolAutonomy = AutonomyLevel;

const catalogsResponseSchema = z.object({
  registrations: z.array(z.object({ catalog: appCapabilityCatalogSchema })),
});
const assignmentSchema = z.object({
  grantId: z.string().min(1),
  resource: resourceRefSchema,
  maximumAutonomy: autonomyLevelSchema,
  limits: z.array(z.object({ key: z.string(), value: z.unknown() })),
  toolNames: z.array(z.string()),
});
const mapResponseSchema = z.object({ assignments: z.array(assignmentSchema) });
const ticketResponseSchema = z.object({
  decision: z.object({ allowed: z.boolean(), reason: z.string() }).passthrough(),
  ticket: z.string().min(1).optional(),
});
type Assignment = z.infer<typeof assignmentSchema>;

export interface OxyExecutionAuthorizationRef {
  id: string;
  /**
   * Correlates Oxy's audit with the normalized action step in Alia. Absent for
   * Alia's standing reads, which belong to the task rather than to one step.
   */
  stepId?: string;
  /**
   * May be called more than once in the run. True only for a standing READ:
   * a declared effect stays once per stage.
   */
  repeatable?: boolean;
}

/** The exact resource and tool an authorization key names. */
function parseExecutionAuthorizationKey(key: string): { resource: ResourceRef; tool: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every((part) => typeof part === 'string')) return null;
    const [appId, effectiveAccountId, resourceType, resourceId, tool] = parsed as string[];
    return { resource: { appId, effectiveAccountId, resourceType, resourceId }, tool };
  } catch {
    return null;
  }
}

export interface OxyToolExecutionContext {
  requesterAccountId: string;
  ownerAccountId: string;
  actor: ActorRef;
  runId?: string;
  autonomy?: OxyToolAutonomy;
  /** Live caller credential used only to create/revoke direct Oxy authority. */
  userAccessToken?: string;
  /** Pre-authorized exact steps for background runs, keyed by resource and tool. */
  executionAuthorizations?: Readonly<Record<string, OxyExecutionAuthorizationRef>>;
  onStepStatus?: (
    stepId: string,
    status: 'running' | 'succeeded' | 'failed',
    auditEventId?: string,
  ) => Promise<void>;
}

interface CompiledTool {
  catalog: AppCapabilityCatalog;
  definition: CatalogTool;
  inputSchema: ZodTypeAny;
  internalCatalogBinding?: CapabilityCatalogBinding;
}
interface CatalogDef {
  catalog: AppCapabilityCatalog;
  displayName: string;
  compiledTools: CompiledTool[];
}
interface BoundTool {
  compiled: CompiledTool;
  resource: ResourceRef;
  suffix: string | null;
}

const defsCache = new TTLCache<CatalogDef[]>({ ttlMs: 60_000, maxSize: 1 });
const contextCache = new TTLCache<string>({ ttlMs: 60_000, maxSize: 2_000 });
const DEFS_KEY = 'catalogs';

/**
 * Oxy refused the AUTHORITY for a call — the execution authorization, the
 * ticket, or the app's check of that ticket — as opposed to the app answering
 * the request itself (a missing message, a bad argument).
 *
 * Keep raw authorization diagnostics out of the model response. Oxy checks
 * the person's account, resource and requested action; being an Oxy app does
 * not bypass that authority. The response names the unavailable app without
 * exposing bearer credentials or internal authorization details.
 */
export class OxyAuthorityUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyAuthorityUnavailableError';
  }
}

async function safeExecute(service: string, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error: unknown) {
    log.general.warn({ err: error, service }, 'Oxy capability tool error');
    if (error instanceof OxyAuthorityUnavailableError) {
      return {
        error: 'oxy_app_unavailable',
        message: `${appDisplayName(service)} is temporarily unavailable. Oxy could not confirm authority for this action. Do not claim it succeeded or use another route to bypass the check. Request any required consent through the supported account flow, or try again when authority is available.`,
      };
    }
    return { error: `${appDisplayName(service)} could not complete the request: ${getErrorMessage(error).slice(0, 180)}` };
  }
}

async function oxyAuthorityFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await oxyServiceToken();
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
  // A configured internal pilot discovers complete registry provenance through
  // the shared service lane. The other apps keep their existing HTTP transport.
  const registrations = INTERNAL_MCP_PILOT
    ? await agency().serviceCatalogs().catch(() => { throw new OxyAuthorityUnavailableError('Internal MCP catalogue authority unavailable'); })
    : catalogsResponseSchema.parse(await oxyAuthorityFetch('/capabilities/catalogs')).registrations;
  return registrations.map((registration) => {
    const catalog = appCapabilityCatalogSchema.parse(registration.catalog);
    let internalCatalogBinding: CapabilityCatalogBinding | undefined;
    if (catalog.appId === INTERNAL_MCP_PILOT) {
      if (!('id' in registration) || !('version' in registration) || !('digest' in registration)) {
        throw new Error('Internal MCP requires complete registry provenance');
      }
      internalCatalogBinding = capabilityCatalogBindingSchema.parse({
        registrationId: registration.id, version: registration.version, digest: registration.digest,
      });
      if (internalCatalogBinding.version !== catalog.version
        || internalCatalogBinding.digest !== createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex')) {
        throw new Error('Registry catalogue content mismatch');
      }
    }
    return {
      catalog,
      displayName: appDisplayName(catalog.appId),
      compiledTools: catalog.tools.filter(definition => definition.exposure.includes('internal'))
        .map(definition => ({ catalog, definition, inputSchema: jsonSchemaToZod(definition.inputSchema),
          ...(internalCatalogBinding ? { internalCatalogBinding } : {}) })),
    };
  });
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
  resource: ResourceRef;
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

/**
 * Alia acting unattended for a task's owner: exactly the tools her standing
 * authority names, on exactly the resources it names — the account roots of
 * the owner's apps for reads, and whatever resource a declared action targets.
 */
function authorizedAliaBindings(
  defs: readonly CatalogDef[],
  authorizations: Readonly<Record<string, OxyExecutionAuthorizationRef>>,
): BoundTool[] {
  const candidates: Array<{ compiled: CompiledTool; resource: ResourceRef }> = [];
  for (const key of Object.keys(authorizations)) {
    const parsed = parseExecutionAuthorizationKey(key);
    if (!parsed) continue;
    const compiled = defs.find((entry) => entry.catalog.appId === parsed.resource.appId)
      ?.compiledTools.find((entry) => entry.definition.name === parsed.tool);
    if (!compiled || !compiled.definition.resourceTypes.includes(parsed.resource.resourceType)) continue;
    candidates.push({ compiled, resource: parsed.resource });
  }
  const counts = new Map<string, number>();
  for (const { compiled } of candidates) {
    const name = `${compiled.catalog.appId}:${compiled.definition.name}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return candidates.map(({ compiled, resource }) => ({
    compiled,
    resource,
    suffix: (counts.get(`${compiled.catalog.appId}:${compiled.definition.name}`) ?? 0) > 1
      ? createHash('sha256').update([resource.resourceType, resource.resourceId, resource.effectiveAccountId].join(':')).digest('hex').slice(0, 8)
      : null,
  }));
}

/**
 * Every READ tool of every Oxy app, bound to the account root of `accountId`:
 * what Alia's standing authority for a task covers at minimum, so "summarise
 * my email every morning" can read the inbox with nobody present.
 */
export async function listOxyAccountReadTools(
  accountId: string,
): Promise<Array<{ resource: ResourceRef; tool: string }>> {
  const defs = await getCatalogDefs();
  return regularAliaBindings(defs, {
    requesterAccountId: accountId,
    ownerAccountId: accountId,
    actor: { type: 'alia', ownerAccountId: accountId },
  })
    .filter((binding) => binding.compiled.definition.effect === 'read')
    .map((binding) => ({ resource: binding.resource, tool: binding.compiled.definition.name }));
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

function resolveInvocation(
  catalog: AppCapabilityCatalog,
  definition: CatalogTool,
  args: Record<string, unknown>,
): {
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
  const baseUrl = new URL(catalog.internalBaseUrl);
  const url = new URL(path, `${catalog.internalBaseUrl}/`);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`Catalog invocation for ${definition.name} escapes its registered app origin`);
  }
  if (definition.invocation.method === 'GET') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return { url, body: undefined };
  }
  return { url, body: remaining };
}

export function oxyExecutionAuthorizationKey(resource: ResourceRef, toolName: string): string {
  return JSON.stringify([
    resource.appId,
    resource.effectiveAccountId,
    resource.resourceType,
    resource.resourceId,
    toolName,
  ]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

/**
 * One key per tool CALL, not per argument set.
 *
 * The model no longer invents an `idempotencyKey` argument (Inbox catalog 2.0.0
 * takes it only from this header), so hashing the arguments would give two
 * deliberate identical calls in one run — star a message, unstar it, star it
 * again — the same key, and Oxy would refuse the repeat as a duplicate. The
 * SDK's `toolCallId` names exactly one call and survives a retry of that call,
 * which is the duplicate this key exists to stop. Without one (a direct
 * caller), the arguments are the best available identity.
 */
export function idempotencyKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJson([runId, toolName, toolCallId ?? args])))
    .digest('hex');
}

function directMaximumAutonomy(
  context: OxyToolExecutionContext,
  definition: CatalogTool,
): OxyToolAutonomy {
  if (definition.effect === 'read') return 'read_only';
  return context.autonomy === 'autonomous'
    ? 'execute_on_request'
    : context.autonomy ?? 'execute_on_request';
}

async function createDirectExecutionAuthorization(
  context: OxyToolExecutionContext,
  resource: ResourceRef,
  definition: CatalogTool,
  runId: string,
  sharedAgency = false,
): Promise<string> {
  if (!context.userAccessToken) {
    throw new Error(`No direct or automation authority exists for ${definition.name}`);
  }
  return createOxyExecutionAuthorization({
    accessToken: context.userAccessToken,
    kind: 'direct_request',
    ownerAccountId: context.ownerAccountId,
    actor: context.actor,
    resource,
    tool: definition.name,
    runId,
    maximumAutonomy: directMaximumAutonomy(context, definition),
    limits: [],
    expiresAt: new Date(Date.now() + 2 * 60_000),
  }, { sharedAgency });
}

interface IssuedTicket {
  ticket: string;
  transientAuthorizationId?: string;
}

const auditedResultSchema = z.object({
  auditEventId: z.string().trim().min(1),
}).passthrough();

function responseAuditEventId(response: Response, result: unknown): string | undefined {
  const header = response.headers.get('x-oxy-audit-event-id')?.trim();
  if (header) return header;
  const parsed = auditedResultSchema.safeParse(result);
  return parsed.success ? parsed.data.auditEventId : undefined;
}

async function revokeTransientAuthorization(
  context: OxyToolExecutionContext,
  authorizationId: string,
  runId: string,
  toolName: string,
  sharedAgency = false,
): Promise<void> {
  if (!context.userAccessToken) return;
  try {
    await revokeOxyExecutionAuthorization(context.userAccessToken, authorizationId, { sharedAgency });
  } catch (error: unknown) {
    if (sharedAgency) throw new OxyAuthorityUnavailableError('Internal MCP requester approval could not be retired');
    log.general.warn(
      { err: error, runId, tool: toolName },
      'Could not revoke transient Oxy execution authorization; expiry remains active',
    );
  }
}

async function issueTicket(
  context: OxyToolExecutionContext,
  resource: ResourceRef,
  definition: CatalogTool,
  runId: string,
  expectedCatalog?: CapabilityCatalogBinding,
): Promise<IssuedTicket> {
  const preauthorized = context.executionAuthorizations?.[
    oxyExecutionAuthorizationKey(resource, definition.name)
  ];
  let executionAuthorizationId: string;
  if (expectedCatalog && !context.runId) throw new OxyAuthorityUnavailableError('Internal MCP requires a named run');
  try {
    executionAuthorizationId = preauthorized?.id ?? await createDirectExecutionAuthorization(
      context,
      resource,
      definition,
      runId,
      expectedCatalog !== undefined,
    );
  } catch (error: unknown) {
    if (expectedCatalog) throw new OxyAuthorityUnavailableError('Internal MCP requester approval unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
  try {
    const request = { executionAuthorizationId,
      ...(preauthorized ? { runId, stepId: preauthorized.stepId } : {}),
      ...(expectedCatalog ? { expectedCatalog } : {}) };
    const parsed = expectedCatalog
      ? await agency().issueCapabilityTicket(request)
      : ticketResponseSchema.parse(await oxyAuthorityFetch('/capabilities/tickets', {
        method: 'POST', body: JSON.stringify(request),
      }));
    if (!parsed.decision.allowed || !parsed.ticket) {
      throw new Error(`Oxy policy denied ${definition.name}: ${parsed.decision.reason}`);
    }
    return {
      ticket: parsed.ticket,
      ...(preauthorized ? {} : { transientAuthorizationId: executionAuthorizationId }),
    };
  } catch (error: unknown) {
    if (!preauthorized) {
      await revokeTransientAuthorization(context, executionAuthorizationId, runId, definition.name, expectedCatalog !== undefined);
    }
    if (expectedCatalog) throw new OxyAuthorityUnavailableError('Internal MCP ticket authority unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
}

async function callBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
  toolCallId?: string,
): Promise<unknown> {
  const runId = context.runId ?? randomUUID();
  const stepId = context.executionAuthorizations?.[
    oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name)
  ]?.stepId;
  if (stepId) await context.onStepStatus?.(stepId, 'running');
  let issued: IssuedTicket | undefined;
  try {
    issued = await issueTicket(context, binding.resource, binding.compiled.definition, runId, binding.compiled.internalCatalogBinding);
    if (binding.compiled.internalCatalogBinding) {
      const endpoint = new URL('/_oxy/mcp', binding.compiled.catalog.internalBaseUrl);
      const client = createInternalCatalogMcpClient({ endpoint: endpoint.href, timeoutMs: TOOL_TIMEOUT_MS });
      const result = await client.callTool(issued.ticket, binding.compiled.definition.name, args, {
        ...(binding.compiled.definition.idempotency === 'required'
          ? { idempotencyKey: idempotencyKey(runId, binding.compiled.definition.name, args, toolCallId) } : {}),
      }).catch(() => { throw new OxyAuthorityUnavailableError('Internal MCP authority or transport unavailable'); });
      if ('isError' in result && result.isError === true) throw new Error('Oxy app could not complete the internal MCP request');
      // Preserve the canonical domain result across HTTP and MCP envelopes.
      const textResult = singleMcpTextResultSchema.safeParse(result);
      const body = result.structuredContent ?? (textResult.success
        ? parseMcpTextResult(textResult.data.content[0].text) : result);
      if (stepId) await context.onStepStatus?.(stepId, 'succeeded', auditedResultSchema.safeParse(body).success ? auditedResultSchema.parse(body).auditEventId : undefined);
      return body;
    }
    const { url, body } = resolveInvocation(binding.compiled.catalog, binding.compiled.definition, args);
    const headers: Record<string, string> = {
      authorization: `Capability ${issued.ticket}`,
      accept: 'application/json',
    };
    if (body) headers['content-type'] = 'application/json';
    if (binding.compiled.definition.idempotency === 'required') {
      headers['idempotency-key'] = idempotencyKey(
        runId,
        binding.compiled.definition.name,
        args,
        toolCallId,
      );
    }
    const response = await fetch(url, {
      method: binding.compiled.definition.invocation.method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const message = `Oxy app error (${response.status}): ${(await response.text()).slice(0, 240)}`;
      // 401/403 is the app refusing the ticket, not the request.
      throw response.status === 401 || response.status === 403
        ? new OxyAuthorityUnavailableError(message)
        : new Error(message);
    }
    const result = await (response.headers.get('content-type')?.includes('application/json')
      ? response.json()
      : response.text());
    if (stepId) {
      await context.onStepStatus?.(
        stepId,
        'succeeded',
        responseAuditEventId(response, result),
      );
    }
    return result;
  } catch (error: unknown) {
    if (stepId) await context.onStepStatus?.(stepId, 'failed');
    throw error;
  } finally {
    if (issued?.transientAuthorizationId && context.userAccessToken) {
      await revokeTransientAuthorization(
        context,
        issued.transientAuthorizationId,
        runId,
        binding.compiled.definition.name,
        binding.compiled.internalCatalogBinding !== undefined,
      );
    }
  }
}

const singleMcpTextResultSchema = z.object({
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).passthrough()]),
}).passthrough();

function parseMcpTextResult(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
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
    const candidateBindings = context.actor.type === 'agent'
      ? agentBindings(defs, await agentAssignments(context))
      : context.executionAuthorizations !== undefined
        ? authorizedAliaBindings(defs, context.executionAuthorizations)
        : regularAliaBindings(defs, context);
    const bindings = context.executionAuthorizations === undefined
      ? candidateBindings
      : candidateBindings.filter((binding) => Object.hasOwn(
          context.executionAuthorizations ?? {},
          oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name),
        ));
    const tools: ToolSet = {};
    for (const binding of bindings) {
      const baseName = `oxy_${sanitizeName(binding.compiled.catalog.appId)}__${sanitizeName(binding.compiled.definition.name)}`;
      const toolName = binding.suffix ? `${baseName}__${binding.suffix}` : baseName;
      let preauthorizedInvocationStarted = false;
      const repeatable = context.executionAuthorizations?.[
        oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name)
      ]?.repeatable === true;
      const built = tool({
        description: `[${appDisplayName(binding.compiled.catalog.appId)}] ${binding.compiled.definition.description} Resource: ${binding.resource.resourceType}/${binding.resource.resourceId}.`,
        inputSchema: binding.compiled.inputSchema,
        execute: async (args: Record<string, unknown>, { toolCallId }: { toolCallId?: string } = {}) => {
          if (context.executionAuthorizations !== undefined && !repeatable) {
            if (preauthorizedInvocationStarted) {
              return { error: `${binding.compiled.definition.name} is authorized once for this automation stage` };
            }
            preauthorizedInvocationStarted = true;
          }
          return safeExecute(
            binding.compiled.catalog.appId,
            () => callBoundTool(binding, args, context, toolCallId),
          );
        },
      });
      // The catalog knows the effect; the runtime policy cannot tell it from the name.
      tools[toolName] = binding.compiled.definition.effect === 'read' ? declareReadOnly(built) : built;
    }
    log.general.info({ userId: oxyUserId, toolCount: Object.keys(tools).length }, 'Oxy capability tools loaded');
    return tools;
  } catch (error: unknown) {
    log.general.error({ err: error, userId: oxyUserId }, 'Failed to load Oxy capability tools');
    return {};
  }
}

export async function getOxyServiceContext(userId: string, accessToken: string): Promise<string> {
  const cached = contextCache.get(userId);
  if (cached !== undefined) return cached;
  const context: OxyToolExecutionContext = {
    requesterAccountId: userId,
    ownerAccountId: userId,
    actor: { type: 'alia', ownerAccountId: userId },
    autonomy: 'read_only',
    userAccessToken: accessToken,
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
    const rendered = `\n\n## The person's Oxy apps\n- **Inbox** (their own Oxy mailbox, already available to you): ${JSON.stringify(result)}`;
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
    return `- **${service.displayName}**: ${names.join(', ')}.`;
  });
  return `\n\n## Oxy apps\nUse the available Oxy app tools for the person's requested actions. Oxy checks account, resource and action authority. If an action is denied, request any required consent through the supported account flow.\n${lines.join('\n')}`;
}
