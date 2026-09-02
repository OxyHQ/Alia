/**
 * The schema drizzle is handed, and the single place a new table must be
 * registered. `drizzle.config.ts` and `createDatabase()` both read this, so a
 * table missing from here exists in TypeScript and in no migration.
 */

export * from './agents';
export * from './agent-sessions';
export * from './agents-support';
export * from './automation';
export * from './agency';
export * from './billing';
export * from './bots';
export * from './chat';
export * from './containers';
export * from './context-graph';
export * from './developers';
export * from './integrations';
export * from './leases';
export * from './library';
export * from './memory';
export * from './moderation';
export * from './notifications';
export * from './organizations';
export * from './providers';
export * from './shows';
export * from './skills';
export * from './telemetry';
export * from './usage';
