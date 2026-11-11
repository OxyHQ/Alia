/**
 * Oxy app tools for Alia.
 *
 * App definitions come from Oxy's signed capability-catalog registry. Each
 * execution asks Oxy for a short-lived capability ticket and sends that ticket
 * to the app; a user's persistent session token is never forwarded or stored.
 */

import { createHash } from 'node:crypto';
import type { AppCapabilityCatalog, CatalogFeature, ResourceRef } from '@oxy.so/contracts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { declareOxyAppTool, declareReadOnly } from '../agent/tool-effects.js';
import { sanitizeOxyToolNamePart as sanitizeName } from './oxy-tool-names.js';
import {
  OxyAuthorityUnavailableError,
  OxyOutcomeUnknownError,
  oxyExecutionAuthorizationKey,
  parseExecutionAuthorizationKey,
  type OxyAgentIdentity,
  type OxyExecutionAuthorizationRef,
  type OxyToolAutonomy,
  type OxyToolExecutionContext,
} from './oxy-call-context.js';
import {
  DEFS_KEY,
  appDisplayName,
  defsCache,
  defsFor,
  getCatalogDefs,
  type BoundTool,
  type CatalogDef,
  type CompiledTool,
} from './oxy-catalog-defs.js';
import {
  RETIRE_APPROVAL_TOOL,
  callBoundTool,
  internalOutcome,
  revokeTransientAuthorization,
  type InternalRetirements,
} from './oxy-invocation.js';

export {
  OxyAuthorityUnavailableError,
  OxyOutcomeUnknownError,
  oxyExecutionAuthorizationKey,
  type OxyAgentIdentity,
  type OxyExecutionAuthorizationRef,
  type OxyToolAutonomy,
  type OxyToolExecutionContext,
} from './oxy-call-context.js';
export { idempotencyKey } from './oxy-invocation.js';

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
        message: `${appDisplayName(service)} is temporarily unavailable. Oxy could not confirm authority for this action. Do not claim it succeeded or use another route to bypass the check. Try again when authority is available.`,
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

function agentIdentityOf(context: OxyToolExecutionContext): OxyAgentIdentity {
  return context.agentIdentity ?? { forUser: 'owner', self: false };
}

/**
 * Catalogue discovery for automation planning, never an authorization grant.
 * Execution still requires the original requester's operation authorization.
 */
export async function getOxyAgentCapabilityMap(context: OxyToolExecutionContext): Promise<
  ReadonlyArray<{
    resource: ResourceRef;
    maximumAutonomy: OxyToolAutonomy;
    limits: ReadonlyArray<{ key: string; value?: unknown }>;
    toolNames: readonly string[];
  }>
> {
  if (context.actor.type !== 'agent' || agentIdentityOf(context).forUser === false) return [];
  return accountRootBindings(
    defsFor(await getCatalogDefs(), 'agent'),
    context.requesterAccountId,
  ).map(({ resource, compiled }) => ({
    resource,
    maximumAutonomy: 'autonomous' as const,
    limits: [],
    toolNames: [compiled.definition.name],
  }));
}

/** Own agent tools always bind the requester, never substitute the agent owner. */
function agentPersonBindings(
  defs: readonly CatalogDef[],
  context: OxyToolExecutionContext,
): BoundTool[] {
  return agentIdentityOf(context).forUser === false
    ? []
    : accountRootBindings(defs, context.requesterAccountId);
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
 * Whose account a tool reaches, said first, because an agent holds BOTH sets
 * and `oxy_inbox__searchEmails` and `self_inbox__searchEmails` read the same.
 */
function toolDescription(binding: BoundTool, context: OxyToolExecutionContext): string {
  const app = appDisplayName(binding.compiled.catalog.appId);
  const resource = `Resource: ${binding.resource.resourceType}/${binding.resource.resourceId}.`;
  if (binding.self) {
    return `[Your own ${app}] YOUR account as this agent (your own ${app.toLowerCase()}, not the person's): ${binding.compiled.definition.description} ${resource}`;
  }

  if (context.actor.type === 'agent') {
    return `[${app}] The PERSON you work for — their own account: ${binding.compiled.definition.description} ${resource}`;
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
    const candidateBindings =
      context.actor.type === 'agent'
        ? [...agentPersonBindings(defs, context), ...agentSelfBindings(defs, context)]
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
          // Oxy and the product enforce the existing policy for this action
          // against the original requester/task; no app-wide permission level.
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
    return { [OXY_APPS_UNAVAILABLE_TOOL]: oxyAppsUnavailableTool() };
  }
}

/** The live app catalogues, for the per-agent permissions editor. */
export async function listOxyAppCatalogs(): Promise<AppCapabilityCatalog[]> {
  return (await getCatalogDefs()).map((entry) => entry.catalog);
}

/** The person's own account, preserved independently of the selected bot owner. */
export function presentPersonAgentContext(params: {
  agent: { oxyAccountId: string; ownerOxyAccountId: string | null };
  personAccountId: string;
  accessToken?: string;
  taskId?: string;
  runId: string;
}): OxyToolExecutionContext | null {
  const ownerIsPresent = params.agent.ownerOxyAccountId === params.personAccountId;
  return {
    requesterAccountId: params.personAccountId,
    ownerAccountId: params.personAccountId,
    actor: { type: 'agent', accountId: params.agent.oxyAccountId },
    agentIdentity: { forUser: ownerIsPresent ? 'owner' : 'requester', self: false },
    runId: params.runId,
    userAccessToken: params.accessToken,
    taskId: params.taskId,
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
  /** The live catalogue has no compatible tool/resource binding. */
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
    const bindings =
      context.actor.type === 'agent'
        ? agentPersonBindings(defs, context)
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
  return `\n\n## Oxy apps\nUse the available Oxy app tools for the person's requested actions. Oxy checks account, resource and action authority. Own Oxy apps need no connection or consent. If an action is unavailable, report it accurately without bypassing account or resource checks.\n${lines.join('\n')}`;
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
      '- `oxy_*` tools act on the account of the person you work for, on the exact requester account. Use them for their email, their data, their behalf.',
    );
  }
  if (self && forUser) {
    lines.push(
      'Never mix the two: reading "my email" when the person asks means theirs (`oxy_*`); an email someone sent to you is in yours (`self_*`).',
    );
  }
  return lines.join('\n');
}
