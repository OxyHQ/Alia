/**
 * The schema drizzle is handed, and the single place a new table must be
 * registered. `drizzle.config.ts` and `createDatabase()` both read this.
 */

export * from './whatsapp';
export * from './telegram';
export * from './signal';
export * from './mcpAuth';
