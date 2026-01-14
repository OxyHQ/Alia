import type { KeyConfig } from './types';
import { connectDB } from './db';
import { ApiKey } from './models/api-key';
import { ApiUsage } from './models/api-usage';

// ============== CONFIG ==============
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface UsageInfo {
  requestsMinute: number;
  tokensMinute: number;
  requestsDay: number;
  tokensDay: number;
}

// ============== GESTIÓN DE KEYS ==============

export async function loadKeys(): Promise<KeyConfig[]> {
  try {
    await connectDB();
    const keys = await ApiKey.find({ isActive: true });
    
    // Si no hay keys en DB, intentar cargar desde .env (migración inicial)
    if (keys.length === 0) {
      console.log('⚠️ No hay keys en MongoDB, intentando cargar desde .env...');
      const initialKeys = getKeysFromEnv();
      if (initialKeys.length > 0) {
        // No esperamos (await) aquí para evitar que el primer usuario espere por la escritura si la DB es lenta,
        // o lo envolvemos en un catch para ignorar fallos de escritura en este punto.
        ApiKey.insertMany(initialKeys).catch(err => console.error('❌ Falló la migración inicial a DB:', err.message));
        return initialKeys;
      }
    }

    return keys.map(k => ({
      provider: k.provider,
      modelId: k.modelId,
      key: k.key,
      isPaid: k.isPaid,
      rpm: k.rpm,
      rpd: k.rpd,
      tpm: k.tpm,
      tpd: k.tpd
    }));
  } catch (e) {
    console.error('⚠️ Error cargando keys de DB, cargando desde .env:', e);
    return getKeysFromEnv();
  }
}

function getKeysFromEnv(): KeyConfig[] {
  const envMapping: Record<string, string> = {
    google: 'GOOGLE_KEYS',
    groq: 'GROQ_KEYS',
    openai: 'OPENAI_KEYS',
    cerebras: 'CEREBRAS_KEYS',
    together: 'TOGETHER_KEYS',
  };

  const configParams = {
    google: { modelId: "gemini-2.0-flash", rpm: 30, rpd: 1000 },
    groq: { modelId: "llama3-70b-8192", rpm: 30 },
    openai: { modelId: "gpt-4o", rpm: 500, isPaid: true }
  } as Record<string, any>;

  const initialKeys: KeyConfig[] = [];

  for (const [provider, envVar] of Object.entries(envMapping)) {
    const keysStr = process.env[envVar];
    if (keysStr) {
      const keyList = keysStr.split(',').map(k => k.trim()).filter(k => k);
      const defaults = configParams[provider] || {};
      
      for (const key of keyList) {
        initialKeys.push({
          provider,
          modelId: defaults.modelId || '',
          key,
          rpm: defaults.rpm,
          rpd: defaults.rpd,
          isPaid: defaults.isPaid || false
        });
      }
    }
  }
  return initialKeys;
}

export async function getAllKeys() {
  await connectDB();
  return await ApiKey.find();
}

export async function addKey(newKey: KeyConfig) {
  await connectDB();
  const exists = await ApiKey.findOne({ key: newKey.key });
  if (exists) throw new Error('La key ya existe');
  
  return await ApiKey.create(newKey);
}

export async function deleteKey(keyStr: string) {
  await connectDB();
  await ApiKey.deleteOne({ key: keyStr });
}

export async function getKeyUsage(keyStr: string): Promise<UsageInfo | null> {
  await connectDB();
  const keyMatch = await ApiKey.findOne({ key: keyStr });
  if (!keyMatch) return null;

  const now = new Date();
  const minuteAgo = new Date(now.getTime() - MINUTE_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const [minuteUsage, dayUsage] = await Promise.all([
    ApiUsage.aggregate([
      { $match: { keyId: keyMatch._id, timestamp: { $gte: minuteAgo } } },
      { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: '$tokens' } } }
    ]),
    ApiUsage.aggregate([
      { $match: { keyId: keyMatch._id, timestamp: { $gte: dayAgo } } },
      { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: '$tokens' } } }
    ])
  ]);

  return {
    requestsMinute: minuteUsage[0]?.count || 0,
    tokensMinute: minuteUsage[0]?.tokens || 0,
    requestsDay: dayUsage[0]?.count || 0,
    tokensDay: dayUsage[0]?.tokens || 0
  };
}

// ============== HELPERS ==============
function progressBar(current: number, max: number): string {
  if (!max) return '';
  const pct = Math.min(100, Math.round((current / max) * 100));
  const filled = Math.round((current / max) * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pct}%`;
}

async function canUseKey(k: any, tokens = 1000): Promise<{ ok: boolean, usage: UsageInfo }> {
  const usage = await getKeyUsage(k.key);
  if (!usage) return { ok: true, usage: { requestsMinute: 0, tokensMinute: 0, requestsDay: 0, tokensDay: 0 } };

  const ok = (!k.rpm || usage.requestsMinute < k.rpm) &&
             (!k.rpd || usage.requestsDay < k.rpd) &&
             (!k.tpm || usage.tokensMinute + tokens <= k.tpm) &&
             (!k.tpd || usage.tokensDay + tokens <= k.tpd);
             
  return { ok, usage };
}

// ============== MAIN ==============
export async function getBestAvailableKey(keyPool: KeyConfig[], tokens = 1000): Promise<KeyConfig | null> {
  let dbKeys: any[] = [];
  try {
    await connectDB();
    dbKeys = await ApiKey.find({ isActive: true });
  } catch (e) {
    console.error('⚠️ Error al buscar keys en DB, usando pool de memoria:', e);
  }
  
  // Si la DB no tiene keys (o falló), usamos el pool que nos pasaron
  const workingKeys = dbKeys.length > 0 ? dbKeys : keyPool;
  
  const free = workingKeys.filter(k => !k.isPaid);
  const paid = workingKeys.filter(k => k.isPaid);

  for (const k of free) {
    const { ok, usage } = await canUseKey(k, tokens);
    if (ok) {
      try {
        await ApiUsage.create({ keyId: k._id, provider: k.provider, tokens });
      } catch (e: any) {
        console.error('⚠️ Error al registrar uso en DB:', e.message);
      }
      console.log(`🆓 ${k.provider}/${k.modelId} [${k.key.slice(-6)}] | RPM: ${usage.requestsMinute + 1}/${k.rpm || '∞'} ${progressBar(usage.requestsMinute + 1, k.rpm || 0)}`);
      return k.toObject ? k.toObject() : k;
    }
  }

  for (const k of paid) {
    const { ok, usage } = await canUseKey(k, tokens);
    if (ok) {
      try {
        await ApiUsage.create({ keyId: k._id, provider: k.provider, tokens });
      } catch (e: any) {
        console.error('⚠️ Error al registrar uso en DB:', e.message);
      }
      console.log(`💳 ${k.provider}/${k.modelId} [${k.key.slice(-6)}] | RPM: ${usage.requestsMinute + 1}/${k.rpm || '∞'}`);
      return k.toObject ? k.toObject() : k;
    }
  }

  console.log('🔥 Todas las keys saturadas');
  return null;
}

export function getStats(keyPool: KeyConfig[]) {
  return {
    total: keyPool.length,
    free: keyPool.filter(k => !k.isPaid).length,
    paid: keyPool.filter(k => k.isPaid).length,
    providers: [...new Set(keyPool.map(k => k.provider))]
  };
}
