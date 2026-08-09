/**
 * The schema drizzle is handed, and the single place a new table must be
 * registered. `drizzle.config.ts` and `createDatabase()` both read this, so a
 * table missing from here exists in TypeScript and in no migration.
 */

export * from './leases';
export * from './telemetry';
