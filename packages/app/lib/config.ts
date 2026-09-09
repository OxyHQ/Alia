import { Platform } from 'react-native';

/**
 * Centralized API configuration
 * Priority:
 * 1. EXPO_PUBLIC_API_URL environment variable (from .env)
 * 2. Fallback to environment-based defaults
 */

// Default API URLs for different environments
export const DEV_API_BASE_URL = 'http://localhost:4150';
export const STAGING_API_BASE_URL = 'https://staging-api.alia.onl';
export const PROD_API_BASE_URL = 'https://api.alia.onl';

const ENV = {
  dev: {
    apiUrl: DEV_API_BASE_URL,
  },
  staging: {
    apiUrl: STAGING_API_BASE_URL,
  },
  prod: {
    apiUrl: PROD_API_BASE_URL,
  },
};

/**
 * The selection a user starts with, and the one a selection the catalogue no
 * longer offers falls back to.
 *
 * Product configuration, not deployment configuration: every build starts in
 * Auto and the server owns what Auto routes to.
 */
export const DEFAULT_MODEL_ID = 'mode:auto';

/**
 * Where Syra lives — `syra.fm` is Oxy's podcast product, and the place a
 * generated show's audio is actually served from.
 *
 * A plain constant rather than part of {@link getEnvVars}, because it does not
 * follow the API's dev/prod switch: a developer running Alia against a local API
 * still plays episodes from the real Syra, since that is where the podcast their
 * series created exists.
 */
export const SYRA_API_URL = process.env.EXPO_PUBLIC_SYRA_API_URL ?? 'https://api.syra.fm';

const getEnvVars = () => {
  // Priority 1: Use EXPO_PUBLIC_API_URL if set in .env
  if (process.env.EXPO_PUBLIC_API_URL) {
    return {
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
    };
  }

  // Priority 2: Use environment-based defaults
  const env = __DEV__ ? 'development' : 'production';

  if (env === 'production') {
    return ENV.prod;
  }

  // For web platform in development, always use localhost
  if (Platform.OS === 'web' && __DEV__) {
    return {
      apiUrl: DEV_API_BASE_URL,
    };
  }

  return ENV.dev;
};

export default getEnvVars();
