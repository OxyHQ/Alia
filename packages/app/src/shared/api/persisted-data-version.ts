import sdkManifest from '@gemies/sdk/package.json';

/**
 * The shape of everything `ALIA_ACCOUNT_QUERIES` writes to disk.
 *
 * `@oxy.so/services` keeps the persisted cache across deploys while this holds (and while its own
 * version does), and drops it when it changes: a restored query is drawn before it is refreshed,
 * so it must be read in the shape it was written in. Bump it with any change to that shape.
 * `__tests__/persisted-data-version.test.ts` fingerprints the declarations those roots are read
 * with and fails until it is bumped, so a forgotten bump is a red test, never a crash in the field.
 */
export const PERSISTED_DATA_VERSION = 1;

/** The SDK's version rides along: its conversation and profile types are persisted too. */
export const PERSISTED_DATA_STAMP = `app${PERSISTED_DATA_VERSION}+sdk${sdkManifest.version}`;
