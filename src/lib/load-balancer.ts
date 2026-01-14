import type { KeyConfig } from './types';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

// ============== CONFIG ==============
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const USAGE_FILE = path.join(process.cwd(), 'usage-data.json');
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_INTERVAL_MS = 10 * 1000;

interface ProviderConfig {
  modelId: string;
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  isPaid?: boolean;
}

interface UsageInfo {
  requestsMinute: number;
  tokensMinute: number;
  minuteReset: number;
  requestsDay: number;
  tokensDay: number;
  dayReset: number;
}

let usageTracker = new Map<string, UsageInfo>();

// ============== GESTIÓN DE KEYS ==============
const KEYS_JSON_FILE = path.join(process.cwd(), 'keys.json');

// Estructura del archivo keys.json
interface KeysFile {
  keys: KeyConfig[];
}

// Cargar keys inicialmente
let loadedKeys: KeyConfig[] = [];

// Función para guardar keys a disco
function saveKeysToDisk() {
  try {
    const data: KeysFile = { keys: loadedKeys };
    writeFileSync(KEYS_JSON_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Keys guardadas en ${KEYS_JSON_FILE}`);
  } catch (e) {
    console.error('❌ Error guardando keys:', e);
  }
}

export function loadKeys(): KeyConfig[] {
  // 1. Intentar cargar de keys.json (persistencia)
  if (existsSync(KEYS_JSON_FILE)) {
    try {
      const data = JSON.parse(readFileSync(KEYS_JSON_FILE, 'utf-8'));
      if (data.keys && Array.isArray(data.keys)) {
        loadedKeys = data.keys;
        console.log(`📋 Cargadas ${loadedKeys.length} keys desde keys.json`);
        return loadedKeys;
      }
    } catch (e) {
      console.error('❌ Error leyendo keys.json', e);
    }
  }

  // 2. Si no hay keys.json, cargar desde .env (migración inicial)
  console.log('⚠️ keys.json no existe o inválido, cargando desde .env...');
  
  // Mapeo de variables de entorno
  const envMapping: Record<string, string> = {
    google: 'GOOGLE_KEYS',
    groq: 'GROQ_KEYS',
    openai: 'OPENAI_KEYS',
    cerebras: 'CEREBRAS_KEYS',
    together: 'TOGETHER_KEYS',
  };

  const configParams = {
    google: { modelId: "gemini-2.5-flash", rpm: 30, rpd: 1000 },
    groq: { modelId: "llama-3.3-70b-versatile", rpm: 30 },
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

  loadedKeys = initialKeys;
  // Guardar inmediatamente si cargamos de ENV para persistir
  if (loadedKeys.length > 0) {
    saveKeysToDisk();
  }
  
  return loadedKeys;
}

export function getAllKeys() {
  // Asegurarnos de tener las últimas
  if (loadedKeys.length === 0) loadKeys();
  return loadedKeys;
}

export function addKey(newKey: KeyConfig) {
  // Validar duplicados
  const exists = loadedKeys.some(k => k.key === newKey.key);
  if (exists) throw new Error('La key ya existe');
  
  loadedKeys.push(newKey);
  saveKeysToDisk();
  return newKey;
}

export function deleteKey(keyVideo: string) {
  loadedKeys = loadedKeys.filter(k => k.key !== keyVideo);
  saveKeysToDisk();
}

export function getKeyUsage(keyStr: string) {
  const matchingKey = loadedKeys.find(k => k.key === keyStr);
  if (!matchingKey) return null;
  const id = getKeyId(matchingKey);
  return usageTracker.get(id);
}

// ============== PERSISTENCIA ==============
function loadUsageFromDisk(): void {
  try {
    if (existsSync(USAGE_FILE)) {
      const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
      usageTracker = new Map(Object.entries(data));
      console.log(`💾 Estado restaurado (${usageTracker.size} keys)`);
    }
  } catch (e) {
    // Sin estado previo
  }
}

function saveUsageToDisk(): void {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(usageTracker), null, 2));
  } catch (e) {}
}

loadUsageFromDisk();
setInterval(saveUsageToDisk, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveUsageToDisk(); process.exit(0); });
process.on('SIGTERM', () => { saveUsageToDisk(); process.exit(0); });

// ============== HELPERS ==============
function progressBar(current: number, max: number): string {
  if (!max) return '';
  const pct = Math.min(100, Math.round((current / max) * 100));
  const filled = Math.round((current / max) * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pct}%`;
}

function getKeyId(k: KeyConfig): string {
  return `${k.provider}-${k.key.slice(-6)}`;
}

function getOrCreateUsage(id: string, now: number): UsageInfo {
  let u = usageTracker.get(id);
  if (!u) {
    u = { requestsMinute: 0, tokensMinute: 0, minuteReset: now + MINUTE_MS,
          requestsDay: 0, tokensDay: 0, dayReset: now + DAY_MS };
    usageTracker.set(id, u);
  }
  if (now > u.minuteReset) { u.requestsMinute = 0; u.tokensMinute = 0; u.minuteReset = now + MINUTE_MS; }
  if (now > u.dayReset) { u.requestsDay = 0; u.tokensDay = 0; u.dayReset = now + DAY_MS; }
  return u;
}

function canUseKey(k: KeyConfig, u: UsageInfo, tokens = 1000): boolean {
  return (!k.rpm || u.requestsMinute < k.rpm) &&
         (!k.rpd || u.requestsDay < k.rpd) &&
         (!k.tpm || u.tokensMinute + tokens <= k.tpm) &&
         (!k.tpd || u.tokensDay + tokens <= k.tpd);
}

// ============== MAIN ==============
export function getBestAvailableKey(keyPool: KeyConfig[], tokens = 1000): KeyConfig | null {
  const now = Date.now();
  const free = keyPool.filter(k => !k.isPaid);
  const paid = keyPool.filter(k => k.isPaid);

  for (const k of free) {
    const u = getOrCreateUsage(getKeyId(k), now);
    if (canUseKey(k, u, tokens)) {
      u.requestsMinute++; u.requestsDay++; u.tokensMinute += tokens; u.tokensDay += tokens;
      console.log(`🆓 ${k.provider}/${k.modelId} [${k.key.slice(-6)}] | RPM: ${u.requestsMinute}/${k.rpm || '∞'} ${progressBar(u.requestsMinute, k.rpm || 0)}`);
      return k;
    }
  }

  for (const k of paid) {
    const u = getOrCreateUsage(getKeyId(k), now);
    if (canUseKey(k, u, tokens)) {
      u.requestsMinute++; u.requestsDay++; u.tokensMinute += tokens; u.tokensDay += tokens;
      console.log(`💳 ${k.provider}/${k.modelId} [${k.key.slice(-6)}] | RPM: ${u.requestsMinute}/${k.rpm || '∞'}`);
      return k;
    }
  }

  console.log('🔥 Todas saturadas');
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
