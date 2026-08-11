/**
 * Broadcast helpers for WebSocket real-time updates.
 * Each function queries fresh data and broadcasts to relevant channels.
 * All are fire-and-forget — errors are logged but never block the caller.
 */

import { broadcast } from '../ws';
import { getDb } from '../../../db/index.js';
import { listSafeProviderKeys } from '../../../db/providers/providerKeyRepository.js';
import { listModelConfigs } from '../../../db/providers/modelConfigRepository.js';
import { listAliaModels } from '../../../db/providers/aliaModelRepository.js';
import { selectPlans } from '../../../db/billing/planRepository.js';
import { selectCreditPackages } from '../../../db/billing/creditPackageRepository.js';
import { selectAllFeatures } from '../../../db/billing/featureRepository.js';
import { selectAllPlanFeatures } from '../../../db/billing/planFeatureRepository.js';
import { getAllProviderHealth, getProviderHealth } from './provider-health';
import { log } from '../../../lib/logger.js';

export async function broadcastKeysUpdate(provider: string): Promise<void> {
  try {
    // No filter: the broadcast carries every key, archived ones included, which
    // is what the admin panel renders. The secrets are excluded by TYPE.
    const allKeys = await listSafeProviderKeys(getDb(), {});
    broadcast('keys:all', { success: true, count: allKeys.length, data: allKeys });

    const providerKeys = allKeys.filter(k => k.provider === provider);
    broadcast(`keys:${provider}`, { success: true, count: providerKeys.length, data: providerKeys });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting keys update');
  }
}

export async function broadcastModelsUpdate(provider: string): Promise<void> {
  try {
    const allModels = await listModelConfigs(getDb(), {});
    broadcast('models:all', { success: true, count: allModels.length, data: allModels });

    const providerModels = allModels.filter(m => m.provider === provider);
    broadcast(`models:${provider}`, { success: true, count: providerModels.length, data: providerModels });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting models update');
  }
}

export async function broadcastAliaModelsUpdate(): Promise<void> {
  try {
    const models = await listAliaModels(getDb());
    broadcast('alia-models:all', { success: true, count: models.length, data: models });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting alia-models update');
  }
}

export async function broadcastPlansUpdate(): Promise<void> {
  try {
    const plans = await selectPlans(getDb());
    broadcast('plans:all', { success: true, count: plans.length, data: plans });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting plans update');
  }
}

export async function broadcastCreditPackagesUpdate(): Promise<void> {
  try {
    const packages = await selectCreditPackages(getDb());
    broadcast('credit-packages:all', { success: true, count: packages.length, data: packages });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting credit-packages update');
  }
}

export async function broadcastFeaturesUpdate(): Promise<void> {
  try {
    const features = await selectAllFeatures(getDb());
    broadcast('features:all', { success: true, count: features.length, data: features });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting features update');
  }
}

export async function broadcastPlanFeaturesUpdate(): Promise<void> {
  try {
    const mappings = await selectAllPlanFeatures(getDb());
    broadcast('plan-features:all', { success: true, count: mappings.length, data: mappings });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting plan-features update');
  }
}

export async function broadcastHealthUpdate(provider: string, modelId: string): Promise<void> {
  try {
    const allHealth = await getAllProviderHealth();
    broadcast('health:all', { success: true, data: allHealth });

    const specificHealth = await getProviderHealth(provider, modelId);
    broadcast(`health:${provider}`, { success: true, data: specificHealth });
    broadcast(`health:${provider}:${modelId}`, { success: true, data: specificHealth });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting health update');
  }
}
