/**
 * Broadcast helpers for WebSocket real-time updates.
 * Each function queries fresh data and broadcasts to relevant channels.
 * All are fire-and-forget — errors are logged but never block the caller.
 */

import { broadcast } from '../ws';
import { ProviderKey } from '../models/provider-key';
import { ModelConfig } from '../models/model-config';
import { AliaModel } from '../models/alia-model';
import { Plan } from '../models/plan';
import { CreditPackage } from '../models/credit-package';
import { Feature } from '../models/feature';
import { PlanFeature } from '../models/plan-feature';
import { getAllProviderHealth, getProviderHealth } from './provider-health';

export async function broadcastKeysUpdate(provider: string): Promise<void> {
  try {
    const allKeys = await ProviderKey.find({})
      .select('-keyHash -key')
      .sort({ provider: 1, priority: 1 });
    broadcast('keys:all', { success: true, count: allKeys.length, data: allKeys });

    const providerKeys = allKeys.filter(k => k.provider === provider);
    broadcast(`keys:${provider}`, { success: true, count: providerKeys.length, data: providerKeys });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting keys update:', error);
  }
}

export async function broadcastModelsUpdate(provider: string): Promise<void> {
  try {
    const allModels = await ModelConfig.find({}).sort({ provider: 1, priority: 1 });
    broadcast('models:all', { success: true, count: allModels.length, data: allModels });

    const providerModels = allModels.filter(m => m.provider === provider);
    broadcast(`models:${provider}`, { success: true, count: providerModels.length, data: providerModels });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting models update:', error);
  }
}

export async function broadcastAliaModelsUpdate(): Promise<void> {
  try {
    const models = await AliaModel.find({}).sort({ tier: 1, aliasModelId: 1 });
    broadcast('alia-models:all', { success: true, count: models.length, data: models });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting alia-models update:', error);
  }
}

export async function broadcastPlansUpdate(): Promise<void> {
  try {
    const plans = await Plan.find({}).sort({ product: 1, sortOrder: 1 }).lean();
    broadcast('plans:all', { success: true, count: plans.length, data: plans });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting plans update:', error);
  }
}

export async function broadcastCreditPackagesUpdate(): Promise<void> {
  try {
    const packages = await CreditPackage.find({}).sort({ sortOrder: 1 }).lean();
    broadcast('credit-packages:all', { success: true, count: packages.length, data: packages });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting credit-packages update:', error);
  }
}

export async function broadcastFeaturesUpdate(): Promise<void> {
  try {
    const features = await Feature.find({}).sort({ category: 1, sortOrder: 1 }).lean();
    broadcast('features:all', { success: true, count: features.length, data: features });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting features update:', error);
  }
}

export async function broadcastPlanFeaturesUpdate(): Promise<void> {
  try {
    const mappings = await PlanFeature.find({}).lean();
    broadcast('plan-features:all', { success: true, count: mappings.length, data: mappings });
  } catch (error) {
    console.error('[Broadcast] Error broadcasting plan-features update:', error);
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
    console.error('[Broadcast] Error broadcasting health update:', error);
  }
}
