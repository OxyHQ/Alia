/**
 * The audit record for a configuration change that affects model or routing
 * behaviour — epic #139 workstream 15, *"Add audit logs for configuration
 * changes that affect model/routing behavior."*
 *
 * ## What counts as such a change, and what does not
 *
 * Five tables decide which model a request can name and which one it resolves
 * to: `routing_profiles`, `routing_profile_provider_mappings`, `model_configs`,
 * `external_models` and `plans`. A write to
 * any of them is a decision a PERSON made about the product, and it is what
 * this records.
 *
 * `plans` joined the list in #139 workstream 14. It is the odd one out and
 * belongs here anyway: it is a BILLING table, but `plans.model_ids` is the
 * input to `lib/plan-access.ts`, which decides whether a request may name a
 * model at all — so a write to it changes which model a caller can reach, which
 * is the property this module is about. Recording it beside the other five
 * rather than inventing a second mechanism is the point; the alternative was a
 * parallel audit path for one column.
 *
 * ## Why a structured log line rather than a table
 *
 * `docs/migration/ownership.md` assigns `model_configs` and the mappings **to
 * Kaana**. An Alia-owned audit table for rows that are leaving is
 * a schema, a migration and an ownership entry for something with a known end
 * date, and it would have to be migrated or abandoned at the cutover. A
 * structured record on its own pino channel is machine-parseable, lands in the
 * same CloudWatch group as everything else, and costs nothing to retire.
 *
 * When the tables move, this module moves with them or is deleted; either way
 * nothing has to be un-migrated.
 *
 * ## Two rules the shape enforces
 *
 * 1. **No prompt or response content, ever.** Nothing here takes a message, a
 *    conversation or a completion; the payload is a per-resource FIELD
 *    ALLOW-LIST ({@link AUDITED_FIELDS}) applied to a row, so a field added
 *    upstream is absent from the record until somebody adds it here on purpose.
 * 2. **No credential material.** The resources this module accepts contain no
 *    hosted provider credential; those rows are no longer part of Alia's
 *    schema.
 */

import { createLogger } from '../logger.js';

/** Which of the five configuration tables the record is about. */
export type ConfigAuditResource =
  | 'routing_profile'
  | 'routing_profile_provider_mappings'
  | 'model_config'
  | 'external_model'
  | 'plan';

/** What happened to it. `upsert` is one statement whose branch is not known. */
export type ConfigAuditAction = 'create' | 'update' | 'delete' | 'upsert' | 'rotate' | 'reset';

/**
 * Who made the change.
 *
 * A required argument on every audited writer rather than something read from an
 * ambient context, because there is no request context in this package to read
 * from — and an actor that defaults to `system` is an audit log that says
 * `system` for the one change somebody needs to attribute.
 *
 *  - `user` — an authenticated person, `id` is their Oxy user id;
 *  - `service` — an internal caller authenticated by `SERVICE_SECRET` or an Oxy
 *    service token, `id` names which;
 *  - `seed` — the boot seeding, `id` names the module;
 *  - `script` — a one-shot run by an operator, `id` names the script.
 */
export interface ConfigAuditActor {
  readonly kind: 'user' | 'service' | 'seed' | 'script';
  readonly id: string;
}

declare const auditedFieldsBrand: unique symbol;

/**
 * A projection {@link auditedFields} produced, and nothing else.
 *
 * The brand exists because the allow-list was one line thick: `after: row`
 * instead of `after: auditedFields('model_config', row)` compiled, ran, and put
 * every column of the row into the audit log — including
 * `model_configs.default_config_system_prompt`, which the allow-list omits on
 * purpose — with the whole suite green. The census in
 * `__tests__/config-audit.test.ts` now refuses that shape too; this refuses it
 * a compiler pass earlier, so the accidental form does not build at all.
 *
 * The two are not redundant. A brand is defeated by `as unknown as`, which the
 * census sees; a census is defeated by a spelling nobody predicted, which the
 * compiler sees. Neither is defeated by the same edit.
 *
 * Type-only: `declare const` emits nothing, so no property is ever written and
 * the value pino receives is the plain object {@link auditedFields} built.
 */
export type AuditedFields = Readonly<Record<string, unknown>> & {
  readonly [auditedFieldsBrand]: true;
};

export interface ConfigAuditChange {
  readonly resource: ConfigAuditResource;
  readonly action: ConfigAuditAction;
  /** The row's own identifier, in whatever form the table's key takes. */
  readonly target: string;
  readonly actor: ConfigAuditActor;
  /** The audited fields as they were. `null` for a create. */
  readonly before: AuditedFields | null;
  /** The audited fields as they are. `null` for a delete. */
  readonly after: AuditedFields | null;
}

/**
 * The fields recorded for each resource, and nothing else.
 *
 * An allow-list rather than a deny-list, which is the whole reason a credential
 * cannot reach a record: a deny-list has to be updated when a column is added
 * and fails OPEN when it is not.
 *
 * Chosen as "what changes routing or visibility". `created_at`, `updated_at` and
 * every counter are omitted — the record carries its own timestamp, and a
 * counter moving is not a configuration change.
 */
export const AUDITED_FIELDS: Readonly<Record<ConfigAuditResource, readonly string[]>> = {
  routing_profile: [
    'routingProfileId',
    'displayName',
    'tier',
    'creditMultiplier',
    'isFreeTier',
    'isActive',
    'isDeprecated',
    'isLegacy',
    'deprecationDate',
    'replacementModelId',
  ],
  routing_profile_provider_mappings: ['provider', 'modelId', 'priority', 'qualityScore', 'isActive'],
  model_config: [
    'provider',
    'modelId',
    'tier',
    'priority',
    'isActive',
    'contextWindow',
    'maxTokens',
    'supportsTools',
    'supportsVision',
    'inputCostPer1M',
    'outputCostPer1M',
  ],
  external_model: ['slug', 'organization', 'isActive', 'contextWindow'],
  // Which models a plan grants, and whether the plan is live at all. Price and
  // Stripe identifiers are money rather than routing and are deliberately out:
  // this module records what changes model ACCESS, and a wider list here would
  // make `plans` the one resource whose records carry unrelated fields.
  plan: ['planId', 'product', 'modelIds', 'isActive'],
};

/**
 * Project a row onto the fields this resource records.
 *
 * `null` in, `null` out, so a create's `before` and a delete's `after` need no
 * special case at the call site. A field the row does not carry is omitted
 * rather than recorded as `undefined`: "absent" and "present and undefined" are
 * different claims and only one of them is true.
 */
export function auditedFields<T extends object>(
  resource: ConfigAuditResource,
  row: T | null | undefined,
): AuditedFields | null {
  if (row === null || row === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS[resource]) {
    // `Reflect.get` rather than an index read: the callers pass repository VIEW
    // interfaces, which have no index signature, and widening them to
    // `Record<string, unknown>` at every call site would be a cast per caller
    // instead of one honest accessor here.
    if (field in row) out[field] = Reflect.get(row, field);
  }
  // The one place the brand is applied, and a plain downcast rather than
  // `as unknown as`: `AuditedFields` is an intersection with `Record<string,
  // unknown>`, so it is a subtype and the assertion needs no widening step.
  return out as AuditedFields;
}

/**
 * The channel, built on FIRST USE rather than at import.
 *
 * Not a micro-optimisation. Every `db/providers/*Repository.ts` imports this
 * module, so it is in the import graph of most of the package — and a
 * `createLogger(...)` at module scope is an import-time side effect that runs in
 * every test whose graph reaches a repository. Two suites that mock
 * `lib/logger.js` with only its `log` export broke on exactly that, at IMPORT,
 * before a single test ran. A module that does nothing until it is called cannot
 * do that to anyone.
 */
let auditLog: ReturnType<typeof createLogger> | null = null;

/**
 * Emit one record.
 *
 * Deliberately not `async` and deliberately unable to fail the write it
 * describes: an audit that can reject a configuration change turns a logging
 * outage into a product outage, and pino's write is synchronous and
 * non-throwing. The trade is stated rather than hidden — if the process dies
 * between the commit and this call, the change happened and is unrecorded.
 *
 * `event` is a constant so a log query can select these without pattern-matching
 * a message.
 */
export function recordConfigChange(change: ConfigAuditChange): void {
  auditLog ??= createLogger('config-audit');
  auditLog.info(
    {
      event: 'config.change',
      resource: change.resource,
      action: change.action,
      target: change.target,
      actor: change.actor,
      before: change.before,
      after: change.after,
      at: new Date().toISOString(),
    },
    'configuration change',
  );
}
