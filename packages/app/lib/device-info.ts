import * as Device from 'expo-device';
import { Platform } from 'react-native';

export interface DeviceInfo {
  deviceName?: string | null;
  modelName?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  platformOS: string;
  brand?: string | null;
  manufacturer?: string | null;
  designName?: string | null;
  deviceYearClass?: number | null;
  totalMemory?: number | null;
}

// Every field is a static device constant — collect once per session.
let cachedDeviceInfo: DeviceInfo | null = null;

/**
 * Collects device information using expo-device
 * This data is only sent to the AI when explicitly requested via the getDeviceInfo tool
 */
export async function collectDeviceInfo(): Promise<DeviceInfo> {
  cachedDeviceInfo ??= {
    deviceName: Device.deviceName,
    modelName: Device.modelName,
    osName: Device.osName,
    osVersion: Device.osVersion,
    platformOS: Platform.OS,
    brand: Device.brand,
    manufacturer: Device.manufacturer,
    designName: Device.designName,
    deviceYearClass: Device.deviceYearClass,
    totalMemory: Device.totalMemory,
  };
  return cachedDeviceInfo;
}

/**
 * Formats device info as a readable string for AI consumption
 */
export function formatDeviceInfo(info: DeviceInfo): string {
  const parts: string[] = [];

  if (info.deviceName) parts.push(`Device: ${info.deviceName}`);
  if (info.manufacturer && info.modelName) {
    parts.push(`Model: ${info.manufacturer} ${info.modelName}`);
  } else if (info.modelName) {
    parts.push(`Model: ${info.modelName}`);
  }
  if (info.osName && info.osVersion) {
    parts.push(`OS: ${info.osName} ${info.osVersion}`);
  }
  if (info.brand) parts.push(`Brand: ${info.brand}`);
  if (info.totalMemory) {
    const memoryGB = (info.totalMemory / (1024 * 1024 * 1024)).toFixed(2);
    parts.push(`RAM: ${memoryGB} GB`);
  }

  return parts.join('\n');
}
