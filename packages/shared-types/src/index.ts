/**
 * @alia/shared-types
 *
 * Canonical TypeScript types shared across the Alia monorepo (API, gateway,
 * integrations, and the Expo app). Add a type here only when it is genuinely
 * cross-cutting; app-internal types stay in their owning package.
 */

// Alia model vocabulary (branded, provider-agnostic model catalog types).
export * from './models.js';
