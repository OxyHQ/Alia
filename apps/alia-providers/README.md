# Alia Providers Microservice

Servicio centralizado de gestión de providers, API keys y configuraciones de modelos para Alia AI.

## 🎯 Propósito

Este microservicio separa completamente la lógica de providers del API principal de Alia, proporcionando:

- **Gestión centralizada de API keys** en MongoDB con auto-recuperación inteligente
- **Configuración dinámica de modelos** sin necesidad de redeployar código
- **Circuit breaker** automático para providers con fallos
- **Rate limiting** por API key y provider
- **Failover automático** entre providers y modelos
- **Seguridad mejorada** - keys nunca expuestas al API principal

## 🏗️ Arquitectura

```
┌─────────────────┐
│   Alia API      │  → Autenticación, Créditos, Conversaciones
└────────┬────────┘
         │ HTTP/REST (auth con HMAC)
         ▼
┌─────────────────┐
│ Alia Providers  │  → Providers, Keys, Health Monitoring
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   MongoDB       │  → ProviderKey, ModelConfig, AliaModel
└─────────────────┘
```

## 📦 Características Principales

### 1. Gestión Inteligente de API Keys

- **Auto-recuperación**: Keys temporalmente fallidas entran en cooldown y se reintent

an automáticamente
- **Archivado automático**: Después de 10 fallos consecutivos, la key se archiva permanentemente
- **Cooldown progresivo**: 3 fallos = 15min cooldown, 4 = 20min, 5 = 25min, etc. (máx 60min)
- **Priorización**: Keys ordenadas por prioridad (free → paid)
- **Rate limiting**: RPM, RPH, RPD, TPM, TPH, TPD por key

### 2. Modelos Virtuales de Alia

Los modelos como `alia-v1`, `alia-lite`, etc. están en MongoDB con sus mappings a providers:

```typescript
{
  aliasModelId: "alia-v1",
  displayName: "Alia V1",
  providerMappings: [
    { provider: "openai", modelId: "gpt-4o", priority: 1 },
    { provider: "anthropic", modelId: "claude-sonnet-4", priority: 2 },
    // ...
  ]
}
```

### 3. Circuit Breaker Automático

- **Circuito cerrado**: Normal operation
- **Circuito abierto**: Después de 5 fallos consecutivos (1 min cooldown)
- **Semi-abierto**: Permite requests de prueba para recuperación

## 🗄️ Esquemas de MongoDB

### ProviderKey

Almacena API keys de providers con seguimiento de fallos:

```typescript
{
  name: "Production OpenAI Key 1",
  provider: "openai",
  keyHash: "sha256...",  // Hash SHA256 de la key (seguro)
  keyPrefix: "sk-proj...",  // Primeros 8 chars para display
  isPaid: true,
  tier: "paid",
  priority: 1,
  rateLimit: { rpm: 500, tpm: 150000 },

  // Auto-recovery
  consecutiveFailures: 0,
  maxRetries: 10,
  cooldownUntil: null,
  isArchived: false
}
```

### ModelConfig

Configuración de modelos de providers:

```typescript
{
  provider: "openai",
  modelId: "gpt-4o",
  displayName: "GPT-4o",
  capabilities: {
    vision: true,
    codeExecution: false,
    webSearch: false,
    thinking: false
  },
  pricing: {
    tier: "paid",
    costPer1MInput: 2.50,
    costPer1MOutput: 10.00
  }
}
```

### AliaModel

Modelos virtuales de Alia con mappings a providers:

```typescript
{
  aliasModelId: "alia-v1",
  displayName: "Alia V1",
  tier: "v1",
  providerMappings: [
    {
      provider: "openai",
      modelId: "gpt-4o",
      priority: 1,
      qualityScore: 92,
      isActive: true
    }
  ],
  creditMultiplier: 1.0
}
```

## 🚀 Instalación y Uso

### Instalación

```bash
cd apps/alia-providers
npm install
```

### Configuración

Copia `.env.example` a `.env` y configura:

```bash
# MongoDB (compartido con API principal)
MONGODB_URI=mongodb://localhost:27017/alia

# Service Authentication
SERVICE_SECRET=tu-secreto-generado-min-32-chars
ALLOWED_SERVICES=alia-api,alia-dashboard

# Server
PORT=3001
NODE_ENV=production
```

### Migración de Keys

Migra tus keys desde variables de entorno a MongoDB:

```bash
npm run migrate:keys
```

### Migración de Modelos

Migra configuraciones de modelos desde TypeScript a MongoDB:

```bash
npm run migrate:models
```

### Iniciar Servidor

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## 🔌 API Endpoints

### Health Check

```bash
GET /health
# Respuesta: { status: "healthy", uptime: 123 }
```

### Providers

#### Resolver Modelo Alia

```bash
POST /v1/providers/resolve
Headers:
  X-Service-Name: alia-api
  X-Timestamp: 1234567890
  X-Signature: hmac-sha256...

Body:
{
  "aliasModelId": "alia-v1",
  "estimatedTokens": 5000,
  "skipProviders": ["openai"]
}

Respuesta:
{
  "success": true,
  "data": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4",
    "keyId": "...",
    "capabilities": {...},
    "pricing": {...}
  }
}
```

#### Proxy a Provider

```bash
POST /v1/providers/:provider/proxy
Headers: [same auth headers]

Body:
{
  "modelId": "gpt-4o",
  "messages": [...],
  "tools": [...],
  "config": { temperature: 0.7 }
}

Respuesta: ReadableStream (SSE/OpenAI format)
```

#### Estado de Health

```bash
GET /v1/providers/health?provider=openai&modelId=gpt-4o
# Respuesta: Circuit breaker state, success rate, latency, etc.
```

#### Registrar Success/Failure

```bash
POST /v1/providers/health/record
Body:
{
  "provider": "openai",
  "modelId": "gpt-4o",
  "success": true,
  "latencyMs": 1200
}
```

### Models

#### Listar Modelos

```bash
GET /v1/models?provider=openai&active=true
GET /v1/models/by-tier/v1
```

#### Obtener Modelo

```bash
GET /v1/models/:provider/:modelId
```

#### Crear/Actualizar Modelo (Admin)

```bash
POST /v1/models
PATCH /v1/models/:provider/:modelId
DELETE /v1/models/:provider/:modelId
```

### Keys (Admin)

#### Listar Keys

```bash
GET /v1/keys?provider=openai&active=true
# Nota: Nunca devuelve la key real, solo el hash y prefix
```

#### Añadir Key

```bash
POST /v1/keys
Body:
{
  "name": "Production OpenAI Key 2",
  "provider": "openai",
  "key": "sk-proj-...",  // Se hashea inmediatamente
  "isPaid": true,
  "priority": 2,
  "rateLimit": { "rpm": 500, "tpm": 150000 }
}
```

#### Rotar Key

```bash
POST /v1/keys/:keyId/rotate
Body: { "newKey": "sk-proj-new..." }
```

#### Activar/Desactivar Key

```bash
POST /v1/keys/:keyId/activate
POST /v1/keys/:keyId/deactivate
DELETE /v1/keys/:keyId
```

## 🔐 Autenticación Service-to-Service

El servicio usa autenticación HMAC para requests entre servicios:

```typescript
// Generar headers de autenticación
const timestamp = Date.now();
const payload = JSON.stringify({ timestamp, service: 'alia-api' });
const signature = crypto
  .createHmac('sha256', SERVICE_SECRET)
  .update(payload)
  .digest('hex');

headers = {
  'X-Service-Name': 'alia-api',
  'X-Timestamp': timestamp.toString(),
  'X-Signature': signature
};
```

**Validación**:
- Service name debe estar en `ALLOWED_SERVICES`
- Timestamp debe ser ≤60 segundos (previene replay attacks)
- Signature debe coincidir con el hash HMAC

## 📊 Gestión de Fallos de Keys

### Comportamiento de Auto-Recuperación

1. **Fallo 1-2**: Key continúa activa
2. **Fallo 3+**: Cooldown progresivo (15-60 min), key desactivada temporalmente
3. **Fallo 10**: Key archivada permanentemente (`isArchived: true`)

### Cooldown Progresivo

```
Fallos consecutivos → Cooldown
3 → 15 min
4 → 20 min
5 → 25 min
...
12+ → 60 min (máximo)
```

### Recovery Automático

- Cuando pasa el cooldown, la key se reactiva automáticamente
- Un success resetea `consecutiveFailures` a 0
- Keys archivadas NO se reactivan automáticamente (requiere intervención manual)

### Ejemplo de Ciclo de Vida

```
1. Key activa → Request falla → consecutiveFailures = 1
2. Otro fallo → consecutiveFailures = 2
3. Tercer fallo → consecutiveFailures = 3, cooldown 15min, isActive = false
4. Después de 15min → Auto-reactivación
5. Request exitoso → consecutiveFailures = 0
```

## 🛠️ Scripts Útiles

```bash
# Migrar keys desde .env a MongoDB
npm run migrate:keys

# Migrar modelos desde TS a MongoDB
npm run migrate:models

# Development con hot-reload
npm run dev

# Build producción
npm run build

# Start production
npm start
```

## 📈 Monitoreo

### Métricas Clave

- Request latency por provider
- Success rate por provider/model
- Circuit breaker state
- Keys rate-limited
- Keys en cooldown
- Keys archivadas

### Logs

El servicio logea:
- ✅ Key recuperaciones exitosas
- ❄️ Keys entrando en cooldown
- 🗄️ Keys siendo archivadas
- ⏰ Auto-reactivaciones después de cooldown

## 🔄 Integración con Alia API

El API principal usa un client para comunicarse con este servicio:

```typescript
import { ProvidersServiceClient } from './lib/providers-client';

const client = new ProvidersServiceClient();

// Resolver modelo
const resolved = await client.resolveModel('alia-v1');

// Hacer request
const stream = await client.proxyRequest('openai', {
  modelId: 'gpt-4o',
  messages: [...]
});

// Registrar health
await client.recordHealth({
  provider: 'openai',
  modelId: 'gpt-4o',
  success: true,
  latencyMs: 1200
});
```

## 🚨 Troubleshooting

### Todas las keys están rate-limited

```bash
# Ver estado de keys
curl http://localhost:3001/v1/keys?provider=openai

# Añadir más keys
curl -X POST http://localhost:3001/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"provider": "openai", "key": "sk-...", ...}'
```

### Provider circuit breaker abierto

```bash
# Ver estado de health
curl http://localhost:3001/v1/providers/health?provider=openai

# Reset manual (si necesario)
# Esperar 60 segundos para transición automática a half-open
```

### Key archivada por error

```bash
# Reactivar key (requiere actualización manual en MongoDB)
# Cambiar isArchived a false y consecutiveFailures a 0
```

## 📝 TODOs Futuros

- [ ] Dashboard admin para gestión visual de keys
- [ ] Webhooks para notificaciones de keys archivadas
- [ ] Cost optimization con selección inteligente de providers
- [ ] A/B testing automático de providers
- [ ] Métricas en tiempo real con WebSockets
- [ ] Automatic key rotation con integración a provider APIs

## 📄 Licencia

Propietario - Alia AI

---

**Desarrollado por Alia AI Team** 🚀
