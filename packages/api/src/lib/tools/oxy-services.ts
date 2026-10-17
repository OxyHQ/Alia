/**
 * Oxy app tools for Alia.
 *
 * App definitions come from Oxy's signed capability-catalog registry. Each
 * execution asks Oxy for a short-lived capability ticket and sends that ticket
 * to the app; a user's persistent session token is never forwarded or stored.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  capabilityCatalogBindingSchema,
  canonicalCapabilityJson,
  type CapabilityCatalogBinding,
  autonomyLevelSchema,
  resourceRefSchema,
  type ActorRef,
  type AppCapabilityCatalog,
  type AutonomyLevel,
  type CatalogFeature,
  type CatalogTool,
  type ResourceRef,
} from '@oxy.so/contracts';
import { jsonSchema, tool, type Schema, type ToolSet } from 'ai';
import {
  createInternalCatalogMcpClient,
  InternalMcpRefusedError,
  jsonObjectSchemaToZod,
} from '@oxy.so/mcp';
import { z } from 'zod';
import {
  type CatalogActorType,
  catalogToolAllowsActor,
  parseRegistryCatalog,
} from './oxy-catalog-actors.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { declareOxyAppTool, declareReadOnly } from '../agent/tool-effects.js';
import {
  createOxyAgentRunAuthorization,
  createOxyExecutionAuthorization,
  revokeOxyExecutionAuthorization,
} from '../oxy-capability-authority.js';
import { oxyServiceClient, oxyServiceToken } from '../oxy-service-client.js';
import { TTLCache } from '../ttl-cache.js';
import { sanitizeOxyToolNamePart as sanitizeName } from './oxy-tool-names.js';

const TOOL_TIMEOUT_MS = 15_000;
function agency() {
  const client = oxyServiceClient();
  if (!client) throw new OxyAuthorityUnavailableError('Alia service identity is unavailable');
  return client.agency;
}
const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');

export type OxyToolAutonomy = AutonomyLevel;

const assignmentTermsSchema = z.object({
  resource: resourceRefSchema,
  maximumAutonomy: autonomyLevelSchema,
  limits: z.array(z.object({ key: z.string(), value: z.unknown() })),
  toolNames: z.array(z.string()),
});
/** The owner's grant to the agent over the owner's data (`/capability-map`). */
const grantMapResponseSchema = z.object({
  assignments: z.array(assignmentTermsSchema.extend({ grantId: z.string().min(1) })),
});
/** The owner's ceiling for the person present, on that person's data (`/requester-capability-map`). */
const ceilingMapResponseSchema = z.object({
  assignments: z.array(assignmentTermsSchema.extend({ ceilingId: z.string().min(1) })),
});
const ticketResponseSchema = z.object({
  decision: z.object({ allowed: z.boolean(), reason: z.string() }).passthrough(),
  ticket: z.string().min(1).optional(),
});
type Assignment = z.infer<typeof assignmentTermsSchema> & { ceilingId?: string };

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
function parseExecutionAuthorizationKey(
  key: string,
): { resource: ResourceRef; tool: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      !parsed.every((part) => typeof part === 'string')
    )
      return null;
    const [appId, effectiveAccountId, resourceType, resourceId, tool] = parsed as string[];
    return { resource: { appId, effectiveAccountId, resourceType, resourceId }, tool };
  } catch {
    return null;
  }
}

/**
 * Which of an AGENT's identities its toolset carries (ADR 0015, ADR 0020 §2).
 *
 *  - `forUser`: the PERSON present's apps, named `oxy_<app>__<tool>`.
 *    - `'owner'`: the person is the agent's owner, so their data is reached
 *      exactly as the agent's Oxy grants allow — the per-app levels the owner
 *      set (*Ver* / *Ver y actuar*).
 *    - `'requester'`: anybody else using the agent; their OWN data is reached
 *      as the owner's published ceiling for each app allows (Oxy ADR 0042),
 *      never the owner's data.
 *    - `false`: none of the person's apps.
 *  - `self`: the agent's OWN bot account — its own Inbox, its own posts —
 *    named `self_<app>__<tool>`. Oxy authorizes it without a grant: the bot is
 *    the agent.
 *  - `unattendedSessionId`: nobody is present (the agent runner). Each call is
 *    authorized through Oxy's agent-run lane, which derives the requester from
 *    the bot's owner; owner effects then need a *Ver y actuar* (autonomous)
 *    grant.
 *
 * Absent on an agent means `{ forUser: 'owner', self: false }`: the preauthorized
 * automation stage, whose exact steps already name their resources.
 */
export interface OxyAgentIdentity {
  forUser: 'owner' | 'requester' | false;
  self: boolean;
  unattendedSessionId?: string;
}

export interface OxyToolExecutionContext {
  requesterAccountId: string;
  ownerAccountId: string;
  actor: ActorRef;
  /** Only read for `actor.type === 'agent'`; see {@link OxyAgentIdentity}. */
  agentIdentity?: OxyAgentIdentity;
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

/**
 * `@oxy.so/mcp` builds its validators with its own Zod major, so only the shape
 * Alia uses is named here.
 */
interface InputValidator {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: ValidationFailure };
}
interface ValidationFailure {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

interface CompiledTool {
  catalog: AppCapabilityCatalog;
  definition: CatalogTool;
  /**
   * The capability's input schema, EXACTLY as the app publishes it in the Oxy
   * registry, and the one thing the model is shown for this tool.
   *
   * It used to be a Zod rebuild of the schema (`jsonSchemaToZod`) that the AI
   * SDK turned back into JSON Schema. The rebuild dropped what it did not model
   * — `minimum`/`maximum`, `maxLength`, `pattern`, `format`,
   * `additionalProperties: false` (it became `passthrough`) — so the model was
   * told `limit` was any number and extra keys were fine, sent `limit: 500` to
   * Noted's `searchNotes`, and the app answered 400
   * `capability_input_schema_mismatch`. The app validates with
   * `jsonObjectSchemaToZod`; so does {@link CompiledTool.validator}, so a call
   * the app would refuse never leaves Alia.
   */
  inputSchema: Schema<Record<string, unknown>>;
  /** The app's own validator (`@oxy.so/mcp` `jsonObjectSchemaToZod`) over the same schema. */
  validator: InputValidator;
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
  /** Bound to the agent's own bot account rather than to the person's. */
  self?: boolean;
  /** Bounded by the agent owner's ceiling for the person present (Oxy ADR 0042). */
  ceilingId?: string;
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

/**
 * Oxy ANSWERED, and the answer was no (403): the requester does not operate the
 * account the lane names — a project or organisation account present as
 * itself, which Oxy never lets operate itself (only a personal account holds
 * authority over its own account). A verdict about this lane, not an outage, so
 * a feature gate reads it as locked rather than as an app that could not answer.
 */
export class OxyAuthorityRefusedError extends OxyAuthorityUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyAuthorityRefusedError';
  }
}

/**
 * The request reached the wire and no answer came back (a timeout, a reset):
 * the app may have committed the effect. Never retried, never reported as a
 * plain failure.
 */
export class OxyOutcomeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyOutcomeUnknownError';
  }
}

async function safeExecute(
  service: string,
  call: { tool: string; argKeys: readonly string[] },
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error: unknown) {
    // Which tool and which argument NAMES (never values: they are the person's
    // content) — a 400 from the app is otherwise indistinguishable from any other.
    log.general.warn(
      { err: error, service, tool: call.tool, argKeys: call.argKeys },
      'Oxy capability tool error',
    );
    if (error instanceof OxyAuthorityUnavailableError) {
      return {
        error: 'oxy_app_unavailable',
        message: `${appDisplayName(service)} is temporarily unavailable. Oxy could not confirm authority for this action. Do not claim it succeeded or use another route to bypass the check. Request any required consent through the supported account flow, or try again when authority is available.`,
      };
    }
    if (error instanceof OxyOutcomeUnknownError) {
      return {
        error: 'oxy_app_result_unknown',
        message: `${appDisplayName(service)} did not answer, so it is not known whether this happened. Do not repeat it and do not claim it succeeded; tell the person to check.`,
      };
    }
    return {
      error: `${appDisplayName(service)} could not complete the request: ${getErrorMessage(error).slice(0, 180)}`,
    };
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
    // Oxy answering "no" (or not answering) about AUTHORITY is
    // `OxyAuthorityUnavailableError`, never a bare Error: the body names Oxy's
    // internal reason (`requester_lacks_grant_owner_authority`) and belongs in
    // the log, not in front of the model.
    const message = `Oxy authority error (${response.status}): ${(await response.text()).slice(0, 240)}`;
    throw response.status === 403
      ? new OxyAuthorityRefusedError(message)
      : new OxyAuthorityUnavailableError(message);
  }
  return response.json();
}

function appDisplayName(appId: string): string {
  return appId.length === 0 ? appId : `${appId.charAt(0).toUpperCase()}${appId.slice(1)}`;
}

async function loadCatalogDefs(): Promise<CatalogDef[]> {
  // Every app uses canonical authority discovery; only the reviewed Mention
  // binding selects MCP for the subsequent product invocation.
  const registrations = await agency()
    .serviceCatalogs()
    .catch(() => {
      throw new OxyAuthorityUnavailableError('Oxy catalogue authority unavailable');
    });
  const defs: CatalogDef[] = [];
  for (const registration of registrations) {
    try {
      defs.push(compileRegistration(registration));
    } catch (error: unknown) {
      // One app's catalogue that this Alia cannot read (a newer contract, a
      // bad registration) costs that app's tools, never every other app's.
      log.general.error(
        { err: error, appId: registryAppId(registration) },
        'Skipping an Oxy capability catalogue that does not parse',
      );
    }
  }
  return defs;
}

type Registration = Awaited<ReturnType<ReturnType<typeof agency>['serviceCatalogs']>>[number];

function registryAppId(registration: { catalog?: unknown }): string | undefined {
  const catalog = registration.catalog;
  return typeof catalog === 'object' &&
    catalog !== null &&
    typeof (catalog as { appId?: unknown }).appId === 'string'
    ? (catalog as { appId: string }).appId
    : undefined;
}

function compileTool(
  catalog: AppCapabilityCatalog,
  definition: CatalogTool,
  internalCatalogBinding: CapabilityCatalogBinding | undefined,
): CompiledTool {
  const validator: InputValidator = jsonObjectSchemaToZod(definition.inputSchema);
  return {
    catalog,
    definition,
    validator,
    inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema, {
      validate: (value) => {
        const parsed = validator.safeParse(value);
        return parsed.success
          ? { success: true, value: parsed.data as Record<string, unknown> }
          : { success: false, error: new Error(describeIssues(parsed.error)) };
      },
    }),
    ...(internalCatalogBinding ? { internalCatalogBinding } : {}),
  };
}

/** What was wrong with a call's input, by argument, for the model to correct. */
function describeIssues(error: ValidationFailure): string {
  return error.issues
    .slice(0, 6)
    .map(
      (issue) =>
        `${issue.path.length ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`,
    )
    .join('; ');
}

function compileRegistration(registration: Registration): CatalogDef {
  const catalog = parseRegistryCatalog(registration.catalog);
  let internalCatalogBinding: CapabilityCatalogBinding | undefined;
  // The app says how its internal tools are reached; a catalogue on the
  // internal MCP lane is pinned to the exact registration it was read from.
  if (catalog.internalTransport === 'mcp') {
    if (!('id' in registration) || !('version' in registration) || !('digest' in registration)) {
      throw new Error('Internal MCP requires complete registry provenance');
    }
    internalCatalogBinding = capabilityCatalogBindingSchema.parse({
      registrationId: registration.id,
      version: registration.version,
      digest: registration.digest,
    });
    if (
      internalCatalogBinding.version !== catalog.version ||
      internalCatalogBinding.digest !==
        createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex')
    ) {
      throw new Error('Registry catalogue content mismatch');
    }
  }
  return {
    catalog,
    displayName: appDisplayName(catalog.appId),
    compiledTools: catalog.tools
      .filter((definition) => definition.exposure.includes('internal'))
      .flatMap((definition) => {
        try {
          return [compileTool(catalog, definition, internalCatalogBinding)];
        } catch (error: unknown) {
          // A schema the app's own validator cannot read is a tool nobody can
          // call correctly; it costs that tool, not the app's others.
          log.general.error(
            { err: error, appId: catalog.appId, tool: definition.name },
            'Skipping an Oxy capability tool whose input schema does not compile',
          );
          return [];
        }
      }),
  };
}

/**
 * Only the tools Oxy will authorize for `actorType` (catalogue `actors`). A
 * tool the actor can never run is not offered at all — Oxy would refuse it
 * with `tool_not_available_to_actor`, which the model can do nothing about.
 */
function defsFor(defs: readonly CatalogDef[], actorType: CatalogActorType): CatalogDef[] {
  return defs.map((service) => ({
    ...service,
    compiledTools: service.compiledTools.filter((compiled) =>
      catalogToolAllowsActor(compiled.definition, actorType),
    ),
  }));
}

function getCatalogDefs(): Promise<CatalogDef[]> {
  return defsCache.getOrLoad(DEFS_KEY, loadCatalogDefs);
}

function agentIdentityOf(context: OxyToolExecutionContext): OxyAgentIdentity {
  return context.agentIdentity ?? { forUser: 'owner', self: false };
}

async function agentAssignments(context: OxyToolExecutionContext): Promise<Assignment[]> {
  const forUser = agentIdentityOf(context).forUser;
  if (context.actor.type !== 'agent' || forUser === false) return [];
  if (forUser === 'requester') {
    // The person's OWN account, under the owner's ceilings: Oxy answers only
    // for an account the requester operates (their own).
    const parsed = ceilingMapResponseSchema.parse(
      await oxyAuthorityFetch('/capabilities/requester-capability-map', {
        method: 'POST',
        body: JSON.stringify({
          requesterAccountId: context.requesterAccountId,
          effectiveAccountId: context.requesterAccountId,
          actorAccountId: context.actor.accountId,
        }),
      }),
    );
    return parsed.assignments;
  }
  const parsed = grantMapResponseSchema.parse(
    await oxyAuthorityFetch('/capabilities/capability-map', {
      method: 'POST',
      body: JSON.stringify({
        requesterAccountId: context.requesterAccountId,
        ownerAccountId: context.ownerAccountId,
        actorAccountId: context.actor.accountId,
      }),
    }),
  );
  return parsed.assignments.map(({ grantId: _grantId, ...terms }) => terms);
}

/** Capability-only view used by the coordinator; it contains no app content. */
export async function getOxyAgentCapabilityMap(context: OxyToolExecutionContext): Promise<
  ReadonlyArray<{
    resource: ResourceRef;
    maximumAutonomy: OxyToolAutonomy;
    limits: ReadonlyArray<{ key: string; value?: unknown }>;
    toolNames: readonly string[];
  }>
> {
  return agentAssignments(context);
}

/** Every internal tool of every app, bound to the account root of `accountId`. */
function accountRootBindings(
  defs: readonly CatalogDef[],
  accountId: string,
  self = false,
): BoundTool[] {
  const bindings: BoundTool[] = [];
  for (const service of defs) {
    for (const compiled of service.compiledTools) {
      if (!compiled.definition.resourceTypes.includes(compiled.catalog.accountResourceType))
        continue;
      bindings.push({
        compiled,
        resource: {
          appId: compiled.catalog.appId,
          effectiveAccountId: accountId,
          resourceType: compiled.catalog.accountResourceType,
          resourceId: accountId,
        },
        suffix: null,
        ...(self ? { self: true } : {}),
      });
    }
  }
  return bindings;
}

function regularAliaBindings(
  defs: readonly CatalogDef[],
  context: OxyToolExecutionContext,
): BoundTool[] {
  return accountRootBindings(defs, context.requesterAccountId);
}

/**
 * The agent AS ITSELF: every app's account root, bound to its own bot account.
 * Oxy authorizes these without a grant (ADR 0018 addendum) — the account is the
 * agent's — and never lets the same agent reach any other account this way.
 */
function agentSelfBindings(
  defs: readonly CatalogDef[],
  context: OxyToolExecutionContext,
): BoundTool[] {
  if (context.actor.type !== 'agent' || !agentIdentityOf(context).self) return [];
  return accountRootBindings(defs, context.actor.accountId, true);
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
    const compiled = defs
      .find((entry) => entry.catalog.appId === parsed.resource.appId)
      ?.compiledTools.find((entry) => entry.definition.name === parsed.tool);
    if (!compiled || !compiled.definition.resourceTypes.includes(parsed.resource.resourceType))
      continue;
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
    suffix:
      (counts.get(`${compiled.catalog.appId}:${compiled.definition.name}`) ?? 0) > 1
        ? createHash('sha256')
            .update(
              [resource.resourceType, resource.resourceId, resource.effectiveAccountId].join(':'),
            )
            .digest('hex')
            .slice(0, 8)
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
  const defs = defsFor(await getCatalogDefs(), 'alia');
  return regularAliaBindings(defs, {
    requesterAccountId: accountId,
    ownerAccountId: accountId,
    actor: { type: 'alia', ownerAccountId: accountId },
  })
    .filter((binding) => binding.compiled.definition.effect === 'read')
    .map((binding) => ({ resource: binding.resource, tool: binding.compiled.definition.name }));
}

/**
 * Whether a grant at `maximumAutonomy` can ever run `definition` in this turn.
 *
 * A *Ver* grant (`read_only`) names whole packages, so the capability map lists
 * that package's writes too; Oxy would refuse every one of them. With nobody
 * present, an effect also needs the grant at `autonomous` (*Ver y actuar*):
 * the agent-run lane asks for exactly that.
 */
function assignmentCanRun(
  maximumAutonomy: OxyToolAutonomy,
  definition: CatalogTool,
  unattended: boolean,
): boolean {
  if (definition.effect === 'read') return true;
  if (unattended) return maximumAutonomy === 'autonomous';
  return maximumAutonomy === 'execute_on_request' || maximumAutonomy === 'autonomous';
}

function agentBindings(
  defs: readonly CatalogDef[],
  assignments: readonly Assignment[],
  unattended = false,
): BoundTool[] {
  const candidates: Array<{ compiled: CompiledTool; assignment: Assignment }> = [];
  for (const assignment of assignments) {
    const service = defs.find((entry) => entry.catalog.appId === assignment.resource.appId);
    if (!service) continue;
    for (const compiled of service.compiledTools) {
      if (!assignment.toolNames.includes(compiled.definition.name)) continue;
      if (!assignmentCanRun(assignment.maximumAutonomy, compiled.definition, unattended)) continue;
      candidates.push({ compiled, assignment });
    }
  }
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.compiled.catalog.appId}:${candidate.compiled.definition.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map(({ compiled, assignment }) => {
    const key = `${compiled.catalog.appId}:${compiled.definition.name}`;
    const digest = createHash('sha256')
      .update(
        [
          assignment.resource.resourceType,
          assignment.resource.resourceId,
          assignment.resource.effectiveAccountId,
        ].join(':'),
      )
      .digest('hex')
      .slice(0, 8);
    return {
      compiled,
      resource: assignment.resource,
      suffix: (counts.get(key) ?? 0) > 1 ? digest : null,
      ...(assignment.ceilingId ? { ceilingId: assignment.ceilingId } : {}),
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
    if (value === undefined || value === null)
      throw new Error(`Missing required path parameter: ${parameter}`);
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
    : (context.autonomy ?? 'execute_on_request');
}

async function createDirectExecutionAuthorization(
  context: OxyToolExecutionContext,
  resource: ResourceRef,
  definition: CatalogTool,
  runId: string,
  ceilingId: string | undefined,
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
    ...(ceilingId ? { ceilingId } : {}),
    expiresAt: new Date(Date.now() + 2 * 60_000),
  });
}

/**
 * An agent's unattended step: Oxy's agent-run lane, with the requester derived
 * by Oxy from the bot's owner — never sent from here. Expires on its own; it
 * is never retired with a bearer nobody holds.
 */
async function createAgentRunExecutionAuthorization(
  context: OxyToolExecutionContext,
  resource: ResourceRef,
  definition: CatalogTool,
  sessionId: string,
): Promise<string> {
  if (context.actor.type !== 'agent') throw new Error('Only an agent has an unattended run lane');
  return createOxyAgentRunAuthorization({
    actorAccountId: context.actor.accountId,
    ownerAccountId: context.ownerAccountId,
    sessionId,
    resource,
    tool: definition.name,
    maximumAutonomy: definition.effect === 'read' ? 'read_only' : 'autonomous',
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
}

interface IssuedTicket {
  ticket: string;
  transientAuthorizationId?: string;
}

const auditedResultSchema = z
  .object({
    auditEventId: z.string().trim().min(1),
  })
  .passthrough();

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
): Promise<boolean> {
  if (!context.userAccessToken) return false;
  try {
    await revokeOxyExecutionAuthorization(context.userAccessToken, authorizationId);
    return true;
  } catch (error: unknown) {
    log.general.warn(
      sharedAgency
        ? { runId, tool: toolName, failure: 'retirement_unavailable' }
        : { err: error, runId, tool: toolName },
      'Could not revoke transient Oxy execution authorization; expiry remains active',
    );
    return false;
  }
}

async function issueTicket(
  context: OxyToolExecutionContext,
  binding: BoundTool,
  runId: string,
  expectedCatalog?: CapabilityCatalogBinding,
  onPendingRetirement?: (authorizationId: string) => void,
): Promise<IssuedTicket> {
  const { resource } = binding;
  const definition = binding.compiled.definition;
  const preauthorized =
    context.executionAuthorizations?.[oxyExecutionAuthorizationKey(resource, definition.name)];
  const unattendedSessionId =
    context.actor.type === 'agent' && !context.userAccessToken
      ? context.agentIdentity?.unattendedSessionId
      : undefined;
  let executionAuthorizationId: string;
  if (expectedCatalog && !context.runId)
    throw new OxyAuthorityUnavailableError('Internal MCP requires a named run');
  try {
    executionAuthorizationId =
      preauthorized?.id ??
      (unattendedSessionId !== undefined
        ? await createAgentRunExecutionAuthorization(
            context,
            resource,
            definition,
            unattendedSessionId,
          )
        : await createDirectExecutionAuthorization(
            context,
            resource,
            definition,
            runId,
            binding.ceilingId,
          ));
  } catch (error: unknown) {
    if (expectedCatalog)
      throw new OxyAuthorityUnavailableError('Internal MCP requester approval unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
  // Both a preauthorized step and an agent run are AUTOMATION authority, whose
  // run is bound when the ticket is issued; a direct request bound its own.
  const automationScoped = preauthorized !== undefined || unattendedSessionId !== undefined;
  try {
    const request = {
      executionAuthorizationId,
      ...(preauthorized
        ? { runId, stepId: preauthorized.stepId }
        : unattendedSessionId !== undefined
          ? { runId }
          : {}),
      ...(expectedCatalog ? { expectedCatalog } : {}),
    };
    const parsed = ticketResponseSchema.parse(await agency().issueCapabilityTicket(request));
    if (!parsed.decision.allowed || !parsed.ticket) {
      throw new Error(`Oxy policy denied ${definition.name}: ${parsed.decision.reason}`);
    }
    return {
      ticket: parsed.ticket,
      ...(automationScoped ? {} : { transientAuthorizationId: executionAuthorizationId }),
    };
  } catch (error: unknown) {
    if (!automationScoped) {
      const retired = await revokeTransientAuthorization(
        context,
        executionAuthorizationId,
        runId,
        definition.name,
        expectedCatalog !== undefined,
      );
      if (!retired) onPendingRetirement?.(executionAuthorizationId);
    }
    if (expectedCatalog)
      throw new OxyAuthorityUnavailableError('Internal MCP ticket authority unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
}

interface InternalOperationOutcome {
  id: string;
  runId: string;
  tool: string;
  status: 'succeeded' | 'not_executed' | 'unknown' | 'failed';
  result?: unknown;
  authorizationId?: string;
  retired: boolean;
  inputDigest: string;
}

// Scoped to one built toolset/run, never global and never containing credentials.
// A receipt is not authority: retry uses the original context's requester bearer.
type InternalRetirements = Map<string, InternalOperationOutcome>;
const RETIRE_APPROVAL_TOOL = 'oxy_mention__retireApproval';
function internalOutcome(outcome: InternalOperationOutcome) {
  return {
    status: outcome.status,
    ...(outcome.status === 'succeeded'
      ? { result: outcome.result }
      : { error: outcome.status === 'unknown' ? 'oxy_app_result_unknown' : 'oxy_app_unavailable' }),
    operation: { id: outcome.id, runId: outcome.runId, tool: outcome.tool },
    retirement: {
      status:
        outcome.authorizationId === undefined
          ? 'not_required'
          : outcome.retired
            ? 'retired'
            : 'pending',
      ...(!outcome.retired ? { retryTool: RETIRE_APPROVAL_TOOL } : {}),
    },
    message:
      outcome.status === 'succeeded'
        ? 'The operation succeeded. Do not execute it again. Only retry pending approval retirement with its operation ID.'
        : outcome.status === 'unknown'
          ? 'The operation outcome is unknown. Do not claim success or start a new operation. Only retry pending approval retirement; that does not resolve the operation outcome.'
          : outcome.status === 'not_executed'
            ? 'The app refused the call before running it, so nothing happened. Tell the person it is unavailable right now; do not claim it ran.'
            : 'The operation was not confirmed successful. Retrying approval retirement never executes the operation.',
  };
}

async function callInternalBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
  toolCallId: string | undefined,
  retirements: InternalRetirements,
  operationKey: string | undefined,
): Promise<unknown> {
  const definition = binding.compiled.definition;
  const runId = context.runId ?? '';
  const operationId =
    operationKey ??
    idempotencyKey(
      runId,
      oxyExecutionAuthorizationKey(binding.resource, definition.name),
      args,
      toolCallId,
    );
  const inputDigest = createHash('sha256').update(canonicalCapabilityJson(args)).digest('hex');
  const previous = retirements.get(operationId);
  // A retry of an operation with pending retirement must not issue new authority
  // or execute the operation, even if the caller repeats its original tool call.
  if (previous) {
    if (previous.inputDigest !== inputDigest)
      return { error: 'oxy_operation_conflict', operationId };
    return internalOutcome(previous);
  }
  const outcome: InternalOperationOutcome = {
    id: operationId,
    runId,
    tool: definition.name,
    status: 'not_executed',
    retired: true,
    inputDigest,
  };
  const stepId =
    context.executionAuthorizations?.[
      oxyExecutionAuthorizationKey(binding.resource, definition.name)
    ]?.stepId;
  if (stepId) await context.onStepStatus?.(stepId, 'running');
  let issued: IssuedTicket;
  try {
    issued = await issueTicket(
      context,
      binding,
      runId,
      binding.compiled.internalCatalogBinding,
      (authorizationId) => {
        outcome.authorizationId = authorizationId;
        outcome.retired = false;
        retirements.set(operationId, outcome);
      },
    );
  } catch (error) {
    if (stepId) await context.onStepStatus?.(stepId, 'failed');
    if (!outcome.retired) return internalOutcome(outcome);
    throw error;
  }
  outcome.authorizationId = issued.transientAuthorizationId;
  outcome.status = 'unknown';
  try {
    const endpoint = new URL('/_oxy/mcp', binding.compiled.catalog.internalBaseUrl);
    const client = createInternalCatalogMcpClient({
      endpoint: endpoint.href,
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const result = await client.callTool(issued.ticket, definition.name, args, {
      ...(definition.idempotency === 'required' ? { idempotencyKey: operationId } : {}),
    });
    if ('isError' in result && result.isError === true) {
      outcome.status = 'failed';
    } else {
      const textResult = singleMcpTextResultSchema.safeParse(result);
      outcome.result =
        result.structuredContent ??
        (textResult.success ? parseMcpTextResult(textResult.data.content[0].text) : result);
      outcome.status = 'succeeded';
    }
  } catch (error: unknown) {
    // Refused before it ran: nothing happened. A read has no effect to be
    // unsure about. Only an effect whose transport failed after the call was
    // sent may have committed, and that alone is unknown. No fallback, remint
    // or retry of the operation is implied by this classification.
    outcome.status =
      error instanceof InternalMcpRefusedError
        ? 'not_executed'
        : definition.effect === 'read'
          ? 'failed'
          : 'unknown';
  }
  if (issued.transientAuthorizationId) {
    outcome.retired = await revokeTransientAuthorization(
      context,
      issued.transientAuthorizationId,
      runId,
      definition.name,
      true,
    );
    if (!outcome.retired) retirements.set(operationId, outcome);
  }
  if (stepId) {
    const audit = auditedResultSchema.safeParse(outcome.result);
    await context.onStepStatus?.(
      stepId,
      outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      audit.success ? audit.data.auditEventId : undefined,
    );
  }
  // Normal successful calls retain the existing domain result shape.
  return outcome.status === 'succeeded' && outcome.retired
    ? outcome.result
    : internalOutcome(outcome);
}

/**
 * `operationKey` replaces the derived idempotency key when the CALLER owns the
 * operation's identity — a feature gate spends once per attached part, across
 * requests, so its key cannot come from this run's id.
 */
async function callBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
  toolCallId?: string,
  retirements: InternalRetirements = new Map(),
  operationKey?: string,
): Promise<unknown> {
  if (binding.compiled.internalCatalogBinding) {
    return callInternalBoundTool(binding, args, context, toolCallId, retirements, operationKey);
  }
  const runId = context.runId ?? randomUUID();
  const stepId =
    context.executionAuthorizations?.[
      oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name)
    ]?.stepId;
  if (stepId) await context.onStepStatus?.(stepId, 'running');
  let issued: IssuedTicket | undefined;
  try {
    issued = await issueTicket(context, binding, runId, binding.compiled.internalCatalogBinding);
    const { url, body } = resolveInvocation(
      binding.compiled.catalog,
      binding.compiled.definition,
      args,
    );
    const headers: Record<string, string> = {
      authorization: `Capability ${issued.ticket}`,
      accept: 'application/json',
    };
    if (body) headers['content-type'] = 'application/json';
    if (binding.compiled.definition.idempotency === 'required') {
      headers['idempotency-key'] =
        operationKey ?? idempotencyKey(runId, binding.compiled.definition.name, args, toolCallId);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: binding.compiled.definition.invocation.method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // Sent, and no answer: the app may have done it.
      throw new OxyOutcomeUnknownError(
        `${binding.compiled.definition.name} sent without an answer: ${getErrorMessage(error).slice(0, 120)}`,
        { cause: error },
      );
    }
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
      await context.onStepStatus?.(stepId, 'succeeded', responseAuditEventId(response, result));
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

const singleMcpTextResultSchema = z
  .object({
    content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).passthrough()]),
  })
  .passthrough();

function parseMcpTextResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Whose account a tool reaches, said first, because an agent holds BOTH sets
 * and `oxy_inbox__searchEmails` and `self_inbox__searchEmails` read the same.
 */
function toolDescription(binding: BoundTool, context: OxyToolExecutionContext): string {
  const app = appDisplayName(binding.compiled.catalog.appId);
  const resource = `Resource: ${binding.resource.resourceType}/${binding.resource.resourceId}.`;
  if (binding.self) {
    return `[Your own ${app}] YOUR account as this agent (your own ${app.toLowerCase()}, not the person's): ${binding.compiled.definition.description} ${resource}`;
  }
  if (binding.ceilingId) {
    return `[${app}] The PERSON you are talking to — their own account, used on their behalf within what you may do for the people who use you: ${binding.compiled.definition.description} ${resource}`;
  }
  if (context.actor.type === 'agent') {
    return `[${app}] The PERSON you work for — their account, used on their behalf within the permissions they gave you: ${binding.compiled.definition.description} ${resource}`;
  }
  return `[${app}] ${binding.compiled.definition.description} ${resource}`;
}

/**
 * Stands in for the owner's apps when Oxy would not say which of them this
 * agent may use. One tool, so the model learns the apps are unavailable from the
 * same typed answer every Oxy tool gives (`oxy_app_unavailable`) instead of
 * concluding the person has none connected.
 */
export const OXY_APPS_UNAVAILABLE_TOOL = 'oxy_apps__status';

function oxyAppsUnavailableTool() {
  return declareReadOnly(
    tool({
      description:
        "[Oxy apps] The person's own Oxy apps (mail, notes, posts…) that you work with. They are " +
        'temporarily unavailable in this conversation: call this to confirm, do not claim you cannot see them.',
      inputSchema: z.object({}),
      execute: async () => ({
        error: 'oxy_app_unavailable',
        message:
          "The person's Oxy apps are temporarily unavailable. Oxy could not confirm authority for this action. Do not claim it succeeded or use another route to bypass the check; try again later.",
      }),
    }),
  );
}

export async function buildOxyServiceTools(
  oxyUserId: string,
  context: OxyToolExecutionContext,
  serviceIds?: readonly string[],
): Promise<ToolSet> {
  try {
    // Alia, and an agent in either identity (its own `self_*` account and its
    // owner's apps), are each ONE actor type to Oxy.
    const allDefs = defsFor(await getCatalogDefs(), context.actor.type);
    const allowed =
      serviceIds === undefined
        ? null
        : new Set(serviceIds.flatMap((id) => [id, id.replace(/^oxy-/, '')]));
    const defs = allowed
      ? allDefs.filter(
          (entry) => allowed.has(entry.catalog.appId) || allowed.has(`oxy-${entry.catalog.appId}`),
        )
      : allDefs;
    // The owner's apps for an agent come from ONE capability-map call across
    // every app, so it fails for all of them or none. When Oxy refuses it (the
    // requester has no `account:act_as` over the owner — Oxy grants an account
    // authority over itself only when it is a personal account), the owner's
    // apps are unavailable for this turn; the agent's own account (`self_*`)
    // and everything else still load.
    let forUserUnavailable = false;
    const forUserAssignments = async (): Promise<Assignment[]> => {
      try {
        return await agentAssignments(context);
      } catch (error: unknown) {
        if (!(error instanceof OxyAuthorityUnavailableError)) throw error;
        forUserUnavailable = true;
        log.general.warn(
          { err: error, userId: oxyUserId },
          "Oxy refused the agent's capability map; the owner's apps are unavailable this turn",
        );
        return [];
      }
    };
    const candidateBindings =
      context.actor.type === 'agent'
        ? [
            ...agentBindings(
              defs,
              await forUserAssignments(),
              agentIdentityOf(context).unattendedSessionId !== undefined &&
                !context.userAccessToken,
            ),
            ...agentSelfBindings(defs, context),
          ]
        : context.executionAuthorizations !== undefined
          ? authorizedAliaBindings(defs, context.executionAuthorizations)
          : regularAliaBindings(defs, context);
    const bindings =
      context.executionAuthorizations === undefined
        ? candidateBindings
        : candidateBindings.filter((binding) =>
            Object.hasOwn(
              context.executionAuthorizations ?? {},
              oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name),
            ),
          );
    const tools: ToolSet = {};
    const retirements: InternalRetirements = new Map();
    for (const binding of bindings) {
      const baseName = `${binding.self ? 'self' : 'oxy'}_${sanitizeName(binding.compiled.catalog.appId)}__${sanitizeName(binding.compiled.definition.name)}`;
      const toolName = binding.suffix ? `${baseName}__${binding.suffix}` : baseName;
      let preauthorizedInvocationStarted = false;
      const repeatable =
        context.executionAuthorizations?.[
          oxyExecutionAuthorizationKey(binding.resource, binding.compiled.definition.name)
        ]?.repeatable === true;
      const built = tool({
        description: toolDescription(binding, context),
        inputSchema: binding.compiled.inputSchema,
        execute: async (
          args: Record<string, unknown>,
          { toolCallId }: { toolCallId?: string } = {},
        ) => {
          // No call waits for the person's OK, a payment or a deletion
          // included (ADR 0020 §3): what the actor may do is its Oxy authority
          // (levels, ceilings, `finance` grants and their limits), checked by
          // Oxy on this very call.
          if (context.executionAuthorizations !== undefined && !repeatable) {
            if (preauthorizedInvocationStarted) {
              return {
                error: `${binding.compiled.definition.name} is authorized once for this automation stage`,
              };
            }
            preauthorizedInvocationStarted = true;
          }
          return safeExecute(
            binding.compiled.catalog.appId,
            { tool: binding.compiled.definition.name, argKeys: Object.keys(args ?? {}) },
            () => callBoundTool(binding, args, context, toolCallId, retirements),
          );
        },
      });
      // The catalog knows the effect; the runtime policy cannot tell it from the
      // name. Every Oxy tool is marked as one: Oxy authorizes it per call, so
      // the agent runtime's own policy never classifies it by name.
      tools[toolName] = declareOxyAppTool(
        binding.compiled.definition.effect === 'read' ? declareReadOnly(built) : built,
      );
    }
    if (forUserUnavailable) tools[OXY_APPS_UNAVAILABLE_TOOL] = oxyAppsUnavailableTool();
    if (
      context.userAccessToken &&
      bindings.some((binding) => binding.compiled.internalCatalogBinding)
    ) {
      if (tools[RETIRE_APPROVAL_TOOL])
        throw new Error('Internal retirement tool name collides with catalogue');
      tools[RETIRE_APPROVAL_TOOL] = tool({
        description:
          'Retry only retirement of a temporary approval created by this run. Never executes or retries a domain operation. Use the operation ID returned with pending retirement.',
        inputSchema: z.object({ operationId: z.string().min(1) }).strict(),
        execute: async ({ operationId }: { operationId: string }) => {
          const outcome = retirements.get(operationId);
          if (!outcome?.authorizationId)
            return { error: 'No pending approval belongs to this operation in this run' };
          if (
            !outcome.retired &&
            (await revokeTransientAuthorization(
              context,
              outcome.authorizationId,
              outcome.runId,
              outcome.tool,
              true,
            ))
          )
            outcome.retired = true;
          return internalOutcome(outcome);
        },
      });
    }
    log.general.info(
      { userId: oxyUserId, toolCount: Object.keys(tools).length },
      'Oxy capability tools loaded',
    );
    return tools;
  } catch (error: unknown) {
    log.general.error({ err: error, userId: oxyUserId }, 'Failed to load Oxy capability tools');
    return {};
  }
}

/** The live app catalogues, for the per-agent permissions editor. */
export async function listOxyAppCatalogs(): Promise<AppCapabilityCatalog[]> {
  return (await getCatalogDefs()).map((entry) => entry.catalog);
}

/**
 * The Oxy context of an agent turn for the PERSON present in it: the owner on
 * the levels they set, anybody else on the owner's published ceilings (ADR
 * 0020 §2) — the two lanes `ToolPipeline.forUser` binds an agent's `oxy_*`
 * tools on. `null` for an agent whose bot has no reconciled owner, which gets
 * no Oxy tools on either lane.
 */
export function presentPersonAgentContext(params: {
  agent: { oxyAccountId: string; ownerOxyAccountId: string | null };
  personAccountId: string;
  accessToken: string;
  runId: string;
}): OxyToolExecutionContext | null {
  if (params.agent.ownerOxyAccountId === null) return null;
  const ownerIsPresent = params.agent.ownerOxyAccountId === params.personAccountId;
  return {
    requesterAccountId: params.personAccountId,
    ownerAccountId: params.personAccountId,
    actor: { type: 'agent', accountId: params.agent.oxyAccountId },
    agentIdentity: { forUser: ownerIsPresent ? 'owner' : 'requester', self: false },
    runId: params.runId,
    userAccessToken: params.accessToken,
  };
}

/**
 * A feature `appId` declares in its live catalogue (`features[]`), with
 * whether its tools take the empty input a gate sends them — the agent
 * editor's check before a gate is saved. `null` when the app or the feature
 * is not in the catalogue.
 */
export async function findOxyAppFeature(
  appId: string,
  featureKey: string,
): Promise<{ feature: CatalogFeature; toolsTakeNoInput: boolean } | null> {
  const service = (await getCatalogDefs()).find((entry) => entry.catalog.appId === appId);
  const feature = service?.catalog.features?.find((entry) => entry.key === featureKey);
  if (!service || !feature) return null;
  const takesNoInput = (name: string | undefined): boolean => {
    if (name === undefined) return true;
    const compiled = service.compiledTools.find((entry) => entry.definition.name === name);
    return compiled !== undefined && compiled.validator.safeParse({}).success;
  };
  return {
    feature,
    toolsTakeNoInput: takesNoInput(feature.checkTool) && takesNoInput(feature.consumeTool),
  };
}

/** What asking an app about a feature came to. */
export type OxyFeatureCall =
  /** The app answered; its answer is the tool's result, unparsed. */
  | { readonly status: 'answered'; readonly result: unknown }
  /** The person's lane does not reach the tool: no level or ceiling covers it. */
  | { readonly status: 'unbound' }
  /** Oxy or the app could not answer. Not a verdict. */
  | { readonly status: 'unavailable' };

/**
 * Call one of an app's feature tools (`checkTool` or `consumeTool`) with no
 * input, on exactly the binding the context's lane gives the model — the same
 * capability map, ticket and transport as an `oxy_*` tool call, never a second
 * path. `operationKey` is the idempotency key of a spend.
 */
export async function callOxyFeatureTool(
  context: OxyToolExecutionContext,
  appId: string,
  toolName: string,
  operationKey?: string,
): Promise<OxyFeatureCall> {
  try {
    const defs = defsFor(await getCatalogDefs(), context.actor.type).filter(
      (entry) => entry.catalog.appId === appId,
    );
    let assignments: Assignment[] = [];
    if (context.actor.type === 'agent') {
      try {
        assignments = await agentAssignments(context);
      } catch (error: unknown) {
        // The person cannot be reached through this agent at all: the same
        // verdict as a lane that binds no tool, so the gate reads as locked.
        if (!(error instanceof OxyAuthorityRefusedError)) throw error;
        log.general.info(
          { appId, tool: toolName },
          'Oxy reaches no account of the person through this agent; the feature is locked',
        );
        return { status: 'unbound' };
      }
    }
    const bindings =
      context.actor.type === 'agent'
        ? agentBindings(defs, assignments)
        : regularAliaBindings(defs, context);
    const binding = bindings.find(
      (candidate) =>
        candidate.compiled.definition.name === toolName &&
        candidate.resource.effectiveAccountId === context.requesterAccountId,
    );
    if (!binding) return { status: 'unbound' };
    return {
      status: 'answered',
      result: await callBoundTool(binding, {}, context, undefined, new Map(), operationKey),
    };
  } catch (error: unknown) {
    log.general.warn({ err: error, appId, tool: toolName }, 'Oxy feature tool unavailable');
    return { status: 'unavailable' };
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
    const compiled = service?.compiledTools.find(
      (entry) => entry.definition.name === 'getEmailContext',
    );
    if (!compiled || !compiled.definition.resourceTypes.includes('email_account')) return '';
    const result = await callBoundTool(
      {
        compiled,
        resource: {
          appId: 'inbox',
          effectiveAccountId: userId,
          resourceType: 'email_account',
          resourceId: userId,
        },
        suffix: null,
      },
      {},
      context,
    );
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
  // Alia's own `oxy_*` names: a tool she can never run is not advertised.
  const lines = defsFor(defs, 'alia')
    .filter((service) => service.compiledTools.length > 0)
    .map((service) => {
      const names = service.compiledTools.map(
        (entry) =>
          `oxy_${sanitizeName(service.catalog.appId)}__${sanitizeName(entry.definition.name)}`,
      );
      return `- **${service.displayName}**: ${names.join(', ')}.`;
    });
  if (lines.length === 0) return '';
  return `\n\n## Oxy apps\nUse the available Oxy app tools for the person's requested actions. Oxy checks account, resource and action authority. If an action is denied, request any required consent through the supported account flow.\n${lines.join('\n')}`;
}

/**
 * What an agent is told about its two identities (ADR 0015), only when its
 * toolset carries Oxy app tools at all. The tool descriptions say the same per
 * tool; this says it once, before the model has to choose between them.
 */
export function agentIdentityPrompt(toolNames: readonly string[]): string {
  const self = toolNames.some((name) => name.startsWith('self_'));
  const forUser = toolNames.some((name) => name.startsWith('oxy_'));
  if (!self && !forUser) return '';
  const lines = ['\n\n## Your accounts'];
  if (self) {
    lines.push(
      '- `self_*` tools act on YOUR OWN Oxy account as this agent: your own inbox, your own profile and sign-ups. Use them for anything addressed to you or done as yourself.',
    );
  }
  if (forUser) {
    lines.push(
      '- `oxy_*` tools act on the account of the person you work for, only within the permissions they gave you. Use them for their email, their data, their behalf.',
    );
  }
  if (self && forUser) {
    lines.push(
      'Never mix the two: reading "my email" when the person asks means theirs (`oxy_*`); an email someone sent to you is in yours (`self_*`).',
    );
  }
  return lines.join('\n');
}
