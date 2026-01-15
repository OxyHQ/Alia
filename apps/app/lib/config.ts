import { Platform } from 'react-native';

// Centralized configuration constants
export const DEV_API_BASE_URL = 'http://nate:3001';
export const STAGING_API_BASE_URL = 'https://staging-api.alia.onl';
export const PROD_API_BASE_URL = 'https://api.alia.onl';

const ENV = {
  dev: {
    apiUrl: `${DEV_API_BASE_URL}/api`,
  },
  staging: {
    apiUrl: `${STAGING_API_BASE_URL}/api`,
  },
  prod: {
    apiUrl: `${PROD_API_BASE_URL}/api`,
  },
};

const getEnvVars = () => {
  // En desarrollo, usar la URL de dev
  // En producción, EAS Build establecerá la variable
  const env = __DEV__ ? 'development' : 'production';

  if (env === 'production') {
    return ENV.prod;
  }

  // For web platform in development, always use localhost
  if (Platform.OS === 'web' && __DEV__) {
    return {
      apiUrl: `${DEV_API_BASE_URL}/api`,
    };
  }

  return ENV.dev;
};

export default getEnvVars();
