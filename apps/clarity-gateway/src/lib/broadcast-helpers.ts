/**
 * Broadcast helpers for WebSocket real-time updates.
 * Each function queries fresh data and broadcasts to relevant channels.
 * All are fire-and-forget — errors are logged but never block the caller.
 */

import { broadcast } from '../ws.js';
import { ProviderKey } from '../models/provider-key.js';
import { ModelConfig } from '../models/model-config.js';
import { ClarityModel } from '../models/clarity-model.js';
import { Plan } from '../models/plan.js';
import { CreditPackage } from '../models/credit-package.js';
import { Feature } from '../models/feature.js';
import { PlanFeature } from '../models/plan-feature.js';
import { getAllProviderHealth, getProviderHealth } from './provider-health';
import { log } from './logger';

export async function broadcastKeysUpdate(provider: string): Promise<void> {
  try {
    const allKeys = await ProviderKey.find({})
      .select('-keyHash -key')
      .sort({ provider: 1, priority: 1 });
    broadcast('keys:all', { success: true, count: allKeys.length, data: allKeys });

    const providerKeys = allKeys.filter((k: any) => k.provider === provider);
    broadcast(`keys:${provider}`, { success: true, count: providerKeys.length, data: providerKeys });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting keys update');
  }
}

export async function broadcastModelsUpdate(provider: string): Promise<void> {
  try {
    const allModels = await ModelConfig.find({}).sort({ provider: 1, priority: 1 });
    broadcast('models:all', { success: true, count: allModels.length, data: allModels });

    const providerModels = allModels.filter((m: any) => m.provider === provider);
    broadcast(`models:${provider}`, { success: true, count: providerModels.length, data: providerModels });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting models update');
  }
}

export async function broadcastClarityModelsUpdate(): Promise<void> {
  try {
    const models = await ClarityModel.find({}).sort({ tier: 1, clarityModelId: 1 });
    broadcast('clarity-models:all', { success: true, count: models.length, data: models });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting clarity-models update');
  }
}

export async function broadcastPlansUpdate(): Promise<void> {
  try {
    const plans = await Plan.find({}).sort({ product: 1, sortOrder: 1 }).lean();
    broadcast('plans:all', { success: true, count: plans.length, data: plans });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting plans update');
  }
}

export async function broadcastCreditPackagesUpdate(): Promise<void> {
  try {
    const packages = await CreditPackage.find({}).sort({ sortOrder: 1 }).lean();
    broadcast('credit-packages:all', { success: true, count: packages.length, data: packages });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting credit-packages update');
  }
}

export async function broadcastFeaturesUpdate(): Promise<void> {
  try {
    const features = await Feature.find({}).sort({ category: 1, sortOrder: 1 }).lean();
    broadcast('features:all', { success: true, count: features.length, data: features });
  } catch (error) {
    log.providers.error({ err: error }, 'Error broadcasting features update');
  }
}

export async function broadcastPlanFeaturesUpdate(): Promise<void> {
  try {
    const mappings = await PlanFeature.find({}).lean();
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
