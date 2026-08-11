/**
 * Oxy service manifests, on Postgres.
 *
 * A manifest declares what another Oxy app can do; `lib/tools/oxy-services.ts`
 * turns `tools[].inputSchema` into Zod schemas at runtime and
 * `routes/oxy-service-events.ts` verifies inbound webhooks against
 * `webhook_secret`. Adding a service is still a DATA change and zero Alia code,
 * which is the property this port had to keep.
 *
 * ## `webhook_secret` is a VERIFICATION key, and that is why it is projected
 *
 * Two of this slice's tables carry a secret that is READ rather than matched on,
 * and they are treated oppositely. `bots.bot_token` is `encryptedText`;
 * `oxy_services.webhook_secret` is plain `text` — not because HMAC keys deserve
 * less, but because Mongoose declared it a plain `String` with no `select:false`
 * and no setter, so encrypting it here would be a change to the security posture
 * wearing the clothes of a port. It is still a credential: `findActiveOxyService`
 * is the ONE reader that projects it, because the signature check cannot be done
 * without it, and `listActiveOxyServiceDefs` deliberately does not — the tool
 * builder has no use for it and a `select()` with no column list would have
 * handed it out.
 */

import { and, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  oxyServices,
  type OxyServiceEvent,
  type OxyServiceStatus,
  type OxyServiceTool,
} from '../schema/oxy-services';

/** A manifest row as stored. */
export type OxyServiceRow = typeof oxyServices.$inferSelect;

/**
 * What the inbound webhook route needs: the signature key, the events table it
 * maps an incoming name through, and the display name it labels notifications
 * with. Named columns, so `webhook_secret` reaches exactly this one caller.
 */
export interface OxyServiceWebhookRow {
  readonly serviceId: string;
  readonly displayName: string;
  readonly webhookSecret: string | null;
  readonly events: OxyServiceEvent[];
}

/**
 * The active manifest for one service id, for the webhook route.
 *
 * `status: 'active'` is part of the filter rather than a check afterwards, so a
 * disabled service is a 404 exactly as it was — the caller cannot accidentally
 * read the row and then forget to look.
 */
export async function findActiveOxyService(
  db: ApiDatabase,
  serviceId: string,
): Promise<OxyServiceWebhookRow | null> {
  const [row] = await db
    .select({
      serviceId: oxyServices.serviceId,
      displayName: oxyServices.displayName,
      webhookSecret: oxyServices.webhookSecret,
      events: oxyServices.events,
    })
    .from(oxyServices)
    .where(and(eq(oxyServices.serviceId, serviceId), eq(oxyServices.status, 'active')))
    .limit(1);

  return row ?? null;
}

/** What the tool builder compiles. No secret, no timestamps. */
export interface OxyServiceDefRow {
  readonly serviceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextEndpoint: string | null;
  readonly tools: OxyServiceTool[];
}

/**
 * Every active manifest, for the 60-second global tool-definition cache.
 *
 * User-independent by design — there is no user filter here and there was none
 * in the source. The caller caches the compiled result once and wraps it per
 * request with the CURRENT access token.
 */
export async function listActiveOxyServiceDefs(db: ApiDatabase): Promise<OxyServiceDefRow[]> {
  return db
    .select({
      serviceId: oxyServices.serviceId,
      displayName: oxyServices.displayName,
      description: oxyServices.description,
      contextEndpoint: oxyServices.contextEndpoint,
      tools: oxyServices.tools,
    })
    .from(oxyServices)
    .where(eq(oxyServices.status, 'active'));
}

/** A manifest as the seed script supplies it. */
export interface OxyServiceManifest {
  readonly serviceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly baseUrl: string;
  readonly icon?: string | undefined;
  readonly status?: OxyServiceStatus | undefined;
  readonly isFirstParty?: boolean | undefined;
  readonly webhookSecret?: string | undefined;
  readonly tools: OxyServiceTool[];
  readonly events: OxyServiceEvent[];
  readonly contextEndpoint?: string | undefined;
}

/**
 * Register or replace a manifest, keyed by `service_id`. Returns the stored row.
 *
 * `ON CONFLICT … DO UPDATE` on the unique `service_id`, which is the exact
 * equivalent of the source's `findOneAndUpdate(…, { upsert: true, new: true })`
 * — one statement, no read-then-write race, and no failed statement to abort a
 * surrounding transaction.
 *
 * The `set` list is spelled out rather than spread: the source passed `$set: svc`
 * with a `Partial<IOxyService>`, so an absent key left the stored value alone.
 * Naming the columns and taking them from a REQUIRED manifest type makes the
 * replacement total instead, which is what "the manifest is the truth" means and
 * what stops a re-seed leaving half of a previous version behind.
 *
 * `updated_at` is deliberately NOT in the list. drizzle applies the column's
 * `$onUpdate` to a conflict `set` clause as well as to a plain `update` —
 * measured, the generated statement ends `do update set … "updated_at" = $N` —
 * so naming it here would be a second author of the same value. `created_at` is
 * untouched on conflict, so a re-seed does not rewrite when the service first
 * registered. Both halves are pinned by the realdb suite.
 */
export async function upsertOxyService(
  db: ApiDatabase,
  manifest: OxyServiceManifest,
): Promise<OxyServiceRow> {
  const values = {
    serviceId: manifest.serviceId,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    baseUrl: manifest.baseUrl,
    icon: manifest.icon ?? null,
    status: manifest.status ?? 'active',
    isFirstParty: manifest.isFirstParty ?? false,
    webhookSecret: manifest.webhookSecret ?? null,
    tools: manifest.tools,
    events: manifest.events,
    contextEndpoint: manifest.contextEndpoint ?? null,
  };

  const [row] = await db
    .insert(oxyServices)
    .values(values)
    .onConflictDoUpdate({
      target: oxyServices.serviceId,
      set: {
        displayName: values.displayName,
        description: values.description,
        version: values.version,
        baseUrl: values.baseUrl,
        icon: values.icon,
        status: values.status,
        isFirstParty: values.isFirstParty,
        webhookSecret: values.webhookSecret,
        tools: values.tools,
        events: values.events,
        contextEndpoint: values.contextEndpoint,
      },
    })
    .returning();

  if (!row) throw new Error(`oxy service upsert returned no row for ${manifest.serviceId}`);
  return row;
}
