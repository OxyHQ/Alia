# Rutas de la API de Alia

## Resumen

La API de Alia tiene dos tipos de endpoints principales:

1. **Chat Interno** (`/alia/chat`) - Para la app de Alia con herramientas y personalización
2. **API OpenAI-Compatible** (`/v1/chat/completions`) - Para desarrolladores externos y editores de código

---

## 1. Chat Interno de Alia

### `POST /alia/chat`

**Descripción**: Endpoint interno para el chat de Alia con todas las funcionalidades.

**Autenticación**: Opcional (via `optionalAuth`)
- Sesiones de Oxy
- Telegram Bot (con secret)
- Anónimo (sin autenticación)

**Características**:
- ✅ Herramientas (Google Search, Memory, Timeline, etc.)
- ✅ Personalización del sistema (basado en perfil de usuario)
- ✅ Streaming SSE
- ✅ Auto-guardado de conversaciones
- ✅ Soporte para Telegram
- ✅ Cobro de créditos basado en tokens y tier del modelo

**Parámetros del Body**:
```json
{
  "messages": [...],
  "conversationId": "uuid",
  "model": "alia-v1" // Opcional, default: alia-v1
}
```

**Modelos Aceptados**:
- `alia-lite` (0.5x créditos)
- `alia-v1` (1x créditos) - **Default**
- `alia-v1-codea` (1.5x créditos)
- `alia-v1-pro` (3x créditos)
- `alia-v1-pro-max` (5x créditos)

**Respuesta**: Server-Sent Events (SSE) con chunks del AI SDK

---

## 2. API OpenAI-Compatible

### `POST /v1/chat/completions`

**Descripción**: Endpoint compatible con OpenAI para desarrolladores externos y editores de código.

**Base URL**: `https://api.alia.onl/v1`

**Autenticación**: Requerida (via `authenticateTokenOrApiKey`)
- Sesiones JWT de Oxy
- API Keys de desarrollador (`alia_sk_*`)

**Características**:
- ✅ OpenAI-compatible
- ✅ Streaming SSE
- ✅ Cobro de créditos basado en tokens y tier del modelo (excluye tokens del system prompt)
- ✅ Soporta tools del editor (function calling)
- ✅ Herramientas internas de Alia (memoria, timeline, Telegram)
- ✅ Personalización basada en perfil de usuario
- ✅ **Conversión automática de tools** para compatibilidad multi-proveedor
- ✅ **Fallback automático** entre proveedores (Google → OpenAI → Anthropic)
- ✅ Prompts específicos por modelo cargados dinámicamente

**Parámetros del Body**:
```json
{
  "messages": [...],
  "model": "alia-v1", // Opcional, default: alia-v1. Puede ser cualquier modelo Alia
  "temperature": 0.7, // Opcional
  "max_tokens": 8192, // Opcional
  "tools": [...] // Opcional: tools del editor
}
```

**Modelos Aceptados**: Todos los modelos Alia
- `alia-lite` (0.5x créditos)
- `alia-v1` (1x créditos) - **Default**
- `alia-v1-codea` (1.5x créditos) - **Recomendado para editores de código**
- `alia-v1-pro` (3x créditos)
- `alia-v1-pro-max` (5x créditos)

**Herramientas Disponibles**:
- Tools del editor (pasadas en el request)
- `getCurrentDate` - Obtener fecha/hora actual
- `getTimeline` - Ver eventos recientes del usuario
- `saveUserMemory` - Guardar información del usuario
- `updateUserPreferences` - Actualizar preferencias
- `updateUserContext` - Actualizar contexto del usuario
- `sendTelegram` - Enviar notificaciones por Telegram

**Respuesta**: OpenAI-compatible SSE
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"alia-v1","choices":[...]}
data: [DONE]
```

**Conversión de Tools (Multi-Proveedor)**:

Los tools enviados por editores como Cursor pueden tener nombres incompatibles con ciertos proveedores (ej: Google requiere nombres alfanuméricos). El sistema automáticamente:

1. **Sanitiza nombres** de funciones para compatibilidad con todos los proveedores
2. **Convierte JSON Schema** a formato Zod para AI SDK
3. **Restaura nombres originales** en las respuestas al cliente

```
Cursor envía:  tools[{function: {name: "read_file#123"}}]
                    ↓
Sanitizado:    "read_file_123" (compatible con Google)
                    ↓
AI SDK → Proveedor (Google/OpenAI/Anthropic)
                    ↓
Respuesta:     Restaura "read_file#123" para Cursor
```

**Uso en Editores de Código (Cursor, VS Code, etc.)**:

Para editores de código, configura:
- **Base URL**: `https://api.alia.onl/v1`
- **Model**: `alia-v1-codea` (en la configuración del editor o request body)
- **API Key**: Tu API key con prefijo `alia_sk_*`


---

### `GET /v1/models`

**Descripción**: Lista todos los modelos Alia disponibles.

**Autenticación**: No requerida

**Respuesta**:
```json
{
  "object": "list",
  "data": [
    {
      "id": "alia-lite",
      "object": "model",
      "name": "Alia Lite",
      "description": "Fast responses for simple tasks",
      "capabilities": {
        "tools": true,
        "vision": false,
        "max_tokens": 4096
      },
      "pricing": {
        "credit_multiplier": 0.5
      }
    },
    ...
  ]
}
```

---

### `GET /v1/models/:modelId`

**Descripción**: Obtiene información detallada de un modelo específico.

**Autenticación**: No requerida

**Ejemplo**: `GET /v1/models/alia-v1-codea`

**Respuesta**: Objeto del modelo con todas las propiedades

---

## 3. Otros Endpoints

### Health Checks

- `GET /health` - Health check general
- `GET /alia/chat` - Estado del servicio de chat interno
- `GET /v1/chat/completions` - Estado del servicio de desarrolladores

### Gestión de Créditos

- `GET /credits` - Ver créditos disponibles (requiere auth)

### Conversaciones

- `GET /conversations` - Listar conversaciones (requiere auth)
- `GET /conversations/:id` - Ver conversación específica
- `DELETE /conversations/:id` - Eliminar conversación

### Memoria de Usuario

- `GET /memory` - Ver memoria del usuario
- `POST /memory` - Actualizar memoria

---

## Modelos Alia

| ID | Nombre | Descripción | Multiplicador | Max Tokens |
|----|--------|-------------|---------------|------------|
| `alia-lite` | Alia Lite | Respuestas rápidas | 0.5x | 4,096 |
| `alia-v1` | Alia V1 | Balance rendimiento/calidad | 1x | 8,192 |
| `alia-v1-codea` | Alia V1 Codea | Optimizado para código | 1.5x | 16,384 |
| `alia-v1-pro` | Alia V1 Pro | Alta calidad | 3x | 32,768 |
| `alia-v1-pro-max` | Alia V1 Pro Max | Mejor disponible | 5x | 128,000 |

---

## Mapeo de Modelos Internos

Cada tier de Alia mapea a modelos reales con fallback automático:

### alia-lite
1. Gemini 2.0 Flash (**default**)
2. Llama 3.3 70B (Groq)
3. Llama 3.3 70B (Cerebras)
4. Llama 3.3 70B (Together)

### alia-v1
1. Gemini 2.5 Flash (**default**)
2. GPT-4o-mini
3. Llama 3.3 70B (Groq)

### alia-v1-codea
1. Gemini 2.5 Pro (**default**)
2. GPT-4o
3. Claude Sonnet 4

### alia-v1-pro
1. GPT-4o (**default**)
2. Claude Sonnet 4
3. Gemini 2.5 Pro

### alia-v1-pro-max
1. Claude Sonnet 4 (**default**)
2. GPT-4o
3. Gemini 2.5 Pro

---

## Sistema de Créditos

**Fórmula**: `créditos = Math.ceil(tokens / 1000) * multiplicador`

**Ejemplo**:
- 1,500 tokens con `alia-v1` (1x) = 2 créditos
- 1,500 tokens con `alia-v1-codea` (1.5x) = 3 créditos
- 1,500 tokens con `alia-v1-pro-max` (5x) = 8 créditos

**Mínimo**: 1 crédito por petición

---

## Autenticación

### Sesiones JWT (Oxy)
```http
Authorization: Bearer <session-token>
```
o
```http
X-Session-Id: <session-token>
```

### API Keys (Desarrolladores)
```http
Authorization: Bearer alia_sk_<key>
```

### Telegram Bot (Interno)
```http
X-Telegram-Bot-Secret: <secret>
X-Oxy-User-Id: <user-id>
X-Telegram-Id: <telegram-id>
```

---

## Resumen de Rutas por Caso de Uso

| Caso de Uso | Ruta | Modelo | Herramientas |
|-------------|------|--------|--------------|
| Chat en la app de Alia | `/alia/chat` | Configurable | ✅ Todas (Google Search, Memory, etc.) |
| API OpenAI-compatible | `/v1/chat/completions` | Configurable | ✅ Function calling + Alia tools (memoria, Telegram) |
| Listar modelos | `/v1/models` | N/A | N/A |

---

## Codea by Alia - VS Code Extension

La extensión **Codea by Alia** está disponible en `/apps/alia-codea/`.

### Instalación

1. Abre VS Code
2. Ve a Extensions → Install from VSIX
3. Selecciona el archivo `.vsix` de la carpeta `alia-codea`

### Configuración

La extensión se conecta automáticamente a:
- **Base URL**: `https://api.alia.onl/v1`
- **Endpoint**: `/v1/chat/completions`
- **Model**: `alia-v1-codea`
- **Autenticación**: API key con prefijo `alia_sk_`

### Características

- Integración nativa con VS Code
- Comandos prefijados con `codea.` y `codea-vscode.`
- Soporte para herramientas del editor
- Streaming de respuestas
- Historial de conversaciones
