import Constants from 'expo-constants';
import { Platform } from 'react-native';
import config from './config';

/**
 * Generate full API URL from a relative path
 * Uses the centralized config which respects EXPO_PUBLIC_API_URL from .env
 *
 * @param relativePath - Relative API path (e.g., '/auth/login', '/alia/chat')
 * @returns Full API URL
 */
export const generateAPIUrl = (relativePath: string): string => {
  const path = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

  // For native apps in development, use Expo's dynamic URL
  if (__DEV__ && Platform.OS !== 'web') {
    const origin = Constants.experienceUrl?.replace('exp://', 'http://');
    if (origin) {
      return origin.concat(path);
    }
  }

  // Use the centralized config (respects EXPO_PUBLIC_API_URL and environment)
  return `${config.apiUrl}${path}`;
};
