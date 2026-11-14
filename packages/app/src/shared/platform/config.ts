/**
 * Where the app finds the API: `EXPO_PUBLIC_API_URL` when it is set (`.env`), else the local API in
 * development and Gemies' backend in a release (ADR 0034). There is no staging API.
 */
const DEV_API_BASE_URL = 'http://localhost:4150';
const PROD_API_BASE_URL = 'https://api.gemies.ai';

const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL || (__DEV__ ? DEV_API_BASE_URL : PROD_API_BASE_URL),
};

export default config;
