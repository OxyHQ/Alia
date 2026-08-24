import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Keep push credentials out of the repository while preserving local native
 * development. EAS file secrets expose a temporary path through the named
 * environment variable; local builds may use the ignored conventional file.
 * Without either file, Android still supports local notifications but does not
 * configure FCM push delivery.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON?.trim() || './google-services.json';
  const android = { ...config.android };

  if (existsSync(resolve(__dirname, googleServicesFile))) {
    android.googleServicesFile = googleServicesFile;
  } else {
    delete android.googleServicesFile;
  }

  return {
    ...config,
    name: config.name ?? 'Alia',
    slug: config.slug ?? 'alia',
    android,
  };
};
