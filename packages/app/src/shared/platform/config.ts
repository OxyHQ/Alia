/**
 * Where the app finds the API: `EXPO_PUBLIC_API_URL` when it is set (`.env`), else the local API in
 * development and Gemies' backend in a release (ADR 0034). There is no staging API.
 */
const DEV_API_BASE_URL = 'http://localhost:4150';
const PROD_API_BASE_URL = 'https://api.gemies.ai';

/**
 * Where Syra lives — `syra.fm` is Oxy's podcast product, and the place a
 * generated show's audio is actually served from.
 *
 * A plain constant rather than part of the API's `config`, because it does not
 * follow the API's dev/prod switch: a developer running Alia against a local API
 * still plays episodes from the real Syra, since that is where the podcast their
 * series created exists.
 */
export const SYRA_API_URL = process.env.EXPO_PUBLIC_SYRA_API_URL ?? 'https://api.syra.fm';

const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL || (__DEV__ ? DEV_API_BASE_URL : PROD_API_BASE_URL),
};

export default config;
