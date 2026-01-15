import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { DEV_API_BASE_URL } from './config';

export const generateAPIUrl = (relativePath: string) => {
  const path = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

  // For web in development, always use localhost
  if (Platform.OS === 'web' && __DEV__) {
    return `${DEV_API_BASE_URL}${path}`;
  }

  // For native apps in development
  if (__DEV__) {
    const origin = Constants.experienceUrl?.replace('exp://', 'http://') || 'http://localhost:8081';
    return origin.concat(path);
  }

  // For production
  if (!process.env.EXPO_PUBLIC_API_BASE_URL) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL environment variable required in production');
  }

  return process.env.EXPO_PUBLIC_API_BASE_URL.concat(path);
};
