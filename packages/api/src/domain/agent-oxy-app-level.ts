/**
 * How much of its owner's data an agent may use in ONE Oxy app.
 *
 * Three levels, one per app, which is the whole permission model the owner sees
 * (ADR 0015): `none` (Nada), `read` (Ver) and `act` (Ver y actuar). Only the
 * last two are stored — an app with no row is `none` — and each stored level is
 * materialised in Oxy as one `DelegationGrant` (`lib/agent-oxy-apps.ts`).
 */
export const OXY_APP_LEVELS = ['none', 'read', 'act'] as const;
export type OxyAppLevel = (typeof OXY_APP_LEVELS)[number];

/** The levels that are a ROW: `none` is the absence of one. */
export const STORED_OXY_APP_LEVELS = ['read', 'act'] as const;
export type StoredOxyAppLevel = (typeof STORED_OXY_APP_LEVELS)[number];
