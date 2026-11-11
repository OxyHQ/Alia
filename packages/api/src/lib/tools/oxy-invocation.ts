/**
 * Calling an Oxy app capability: the execution authorization, the short-lived
 * ticket, the HTTP or internal-MCP invocation, its idempotency key and the
 * retirement of transient approvals. Takes a bound tool (`oxy-catalog-defs.ts`)
 * and a context (`oxy-call-context.ts`); never decides which tools exist.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  firstPartyExecutionAuthorizationInputSchema,
  canonicalCapabilityJson,
  type CapabilityCatalogBinding,
  type AppCapabilityCatalog,
  type CatalogTool,
  type ResourceRef,
} from '@oxy.so/contracts';
import { createInternalCatalogMcpClient, InternalMcpRefusedError } from '@oxy.so/mcp';
import { z } from 'zod';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { revokeOxyExecutionAuthorization } from '../oxy-capability-authority.js';
import { agency, type BoundTool } from './oxy-catalog-defs.js';
import {
  OxyAuthorityUnavailableError,
  OxyOutcomeUnknownError,
  oxyExecutionAuthorizationKey,
  type OxyToolExecutionContext,
} from './oxy-call-context.js';

const TOOL_TIMEOUT_MS = 15_000;

const ticketResponseSchema = z.object({
  decision: z.object({ allowed: z.boolean(), reason: z.string() }).loose(),
  ticket: z.string().min(1).optional(),
});

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

async function createDirectExecutionAuthorization(
  context: OxyToolExecutionContext,
  binding: BoundTool,
  runId: string,
): Promise<string> {
  const terms = firstPartyExecutionAuthorizationInputSchema.parse({
    authority: 'first_party' as const,
    kind: 'direct_request' as const,
    actor: context.actor,
    resource: binding.resource,
    tool: binding.compiled.definition.name,
    expectedCatalog: binding.compiled.catalogBinding,
    runId,
    expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
  });
  if (context.taskId)
    return (await agency().createTaskExecutionAuthorization(context.taskId, terms)).id;
  if (!context.userAccessToken)
    throw new Error('No verified requester authority exists for this operation');
  return (
    await agency().createForegroundExecutionAuthorization(terms, {
      requesterToken: context.userAccessToken,
    })
  ).id;
}

interface IssuedTicket {
  ticket: string;
  transientAuthorizationId?: string;
}

const auditedResultSchema = z
  .object({
    auditEventId: z.string().trim().min(1),
  })
  .loose();

function responseAuditEventId(response: Response, result: unknown): string | undefined {
  const header = response.headers.get('x-oxy-audit-event-id')?.trim();
  if (header) return header;
  const parsed = auditedResultSchema.safeParse(result);
  return parsed.success ? parsed.data.auditEventId : undefined;
}

export async function revokeTransientAuthorization(
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
  let executionAuthorizationId: string;
  if (expectedCatalog && !context.runId)
    throw new OxyAuthorityUnavailableError('Internal MCP requires a named run');
  try {
    executionAuthorizationId =
      preauthorized?.id ?? (await createDirectExecutionAuthorization(context, binding, runId));
  } catch (error: unknown) {
    if (expectedCatalog)
      throw new OxyAuthorityUnavailableError('Internal MCP requester approval unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
  // Both a preauthorized step and an agent run are AUTOMATION authority, whose
  // run is bound when the ticket is issued; a direct request bound its own.
  const automationScoped = preauthorized !== undefined || context.taskId !== undefined;
  try {
    const request = {
      executionAuthorizationId,
      ...(preauthorized ? { runId, stepId: preauthorized.stepId } : {}),
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
export type InternalRetirements = Map<string, InternalOperationOutcome>;
export const RETIRE_APPROVAL_TOOL = 'oxy_mention__retireApproval';
export function internalOutcome(outcome: InternalOperationOutcome) {
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
export async function callBoundTool(
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
    content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).loose()]),
  })
  .loose();

function parseMcpTextResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
