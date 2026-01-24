# Mastodon Bot para Alia AI

Bot autónomo de Mastodon que permite a @alia@alia.onl responder menciones automáticamente usando IA.

## Características

- **Autónomo**: Responde automáticamente a menciones sin intervención manual
- **Contexto de conversación**: Mantiene contexto de threads para respuestas coherentes
- **IA integrada**: Usa el modelo `alia-lite` por defecto para respuestas rápidas
- **Límite de caracteres**: Respeta el límite de 500 caracteres de Mastodon
- **Visibilidad adaptativa**: Respeta la visibilidad del toot original

## Arquitectura

```
Mastodon (@alia@alia.onl)
        ↓
   [Menciones]
        ↓
   Polling (30s)
        ↓
  Mastodon Bot
        ↓
   API de Alia
        ↓
   Respuesta IA
```

## Configuración Inicial

### 1. Crear Aplicación en Mastodon

1. Ir a `https://alia.onl/settings/applications/new`
2. Configurar la aplicación:
   - **Nombre**: "Alia AI Assistant"
   - **Redirect URI**: `urn:ietf:wg:oauth:2.0:oob`
   - **Scopes**: `read write follow push`
3. Guardar y copiar el **Access Token** generado

### 2. Configurar Variables de Entorno

Crear archivo `.env` en `apps/mastodon-bot/`:

```bash
# Instancia de Mastodon
MASTODON_INSTANCE_URL=https://alia.onl
MASTODON_ACCESS_TOKEN=tu_token_aqui

# Servidor API
API_BASE_URL=http://localhost:3001

# Secreto compartido (debe ser el mismo en apps/api/.env)
MASTODON_BOT_SECRET=genera_un_secreto_aleatorio_seguro

# Configuración de polling (opcional)
NOTIFICATION_POLL_INTERVAL=30000

# Entorno
NODE_ENV=development
```

**Generar secreto seguro**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Configurar API Backend

Agregar a `apps/api/.env`:

```bash
# Bot de Mastodon
MASTODON_BOT_SECRET=el_mismo_secreto_del_paso_anterior
```

### 4. Instalar Dependencias

Desde la raíz del monorepo:

```bash
npm install
```

## Uso

### Desarrollo

```bash
# Desde la raíz del proyecto
npm run dev:mastodon
```

### Producción

```bash
# Build
npm run build:mastodon

# Start
npm run start:mastodon
```

## Cómo Funciona

1. **Polling**: El bot verifica nuevas menciones cada 30 segundos
2. **Detección**: Cuando detecta una mención a @alia:
   - Extrae el texto (limpia HTML y menciones)
   - Si es un thread, obtiene contexto de mensajes anteriores
3. **Procesamiento**:
   - Llama a `/alia/chat` con el contexto
   - Usa autenticación con `MASTODON_BOT_SECRET`
   - Modelo por defecto: `alia-lite`
4. **Respuesta**:
   - Limita respuesta a 450 caracteres
   - Responde como reply al toot original
   - Mantiene la misma visibilidad (public/unlisted/private)

## Estructura del Código

```
apps/mastodon-bot/
├── src/
│   ├── index.ts                    # Entry point, polling loop
│   ├── services/
│   │   └── alia-api.ts            # Cliente API de Alia
│   └── handlers/
│       └── mentions.ts             # Lógica de menciones
├── package.json
├── tsconfig.json
└── .env.example
```

## Ejemplo de Interacción

**Usuario en Mastodon**:
```
@alia ¿Qué es la inteligencia artificial?
```

**Bot responde**:
```
@usuario La inteligencia artificial (IA) es la simulación de procesos de
inteligencia humana por sistemas informáticos. Incluye aprendizaje
automático, razonamiento y auto-corrección. Se usa en reconocimiento de
voz, visión por computadora, traducción y más.
```

## Características Avanzadas

### Contexto de Threads

Si un usuario responde a un toot anterior de Alia, el bot mantiene contexto:

```
Usuario: @alia ¿Qué es Machine Learning?
Alia: [Respuesta sobre ML]
Usuario: @alia ¿Y Deep Learning?
Alia: [Respuesta considerando el contexto de ML]
```

### Manejo de Errores

- Si hay un error de API, registra en logs
- Para mensajes privados/directos, puede enviar mensaje de error al usuario
- Continúa procesando otras menciones incluso si una falla

## Debugging

### Ver Logs

```bash
# Modo desarrollo (con watch)
npm run dev:mastodon

# Logs incluyen:
# [Mastodon Bot] Connected as @alia@alia.onl
# [Mastodon Bot] Found 2 new mention(s)
# [Mentions] Processing mention from @usuario
# [Mentions] Mention text: "¿Qué es IA?"
# [Mentions] Context: 3 messages
# [Mentions] Generated response in 1234ms
# [Mentions] Posted reply: https://alia.onl/@alia/123456
```

### Problemas Comunes

**Error: Missing required environment variable**
- Verificar que `.env` existe y tiene todas las variables

**Error: Invalid bot authentication**
- Verificar que `MASTODON_BOT_SECRET` coincide en bot y API

**Error: API request failed: 401**
- Verificar que `MASTODON_ACCESS_TOKEN` es válido
- Verificar que la app tiene los scopes correctos

**No detecta menciones**
- Verificar conexión a internet
- Verificar que el token no expiró
- Revisar logs para errores de Mastodon API

## Seguridad

- ✅ Autenticación con secreto compartido (bot-to-API)
- ✅ Comparación constant-time para prevenir timing attacks
- ✅ Validación de origen (header `X-Source`)
- ✅ Rate limiting respetado (300 req/5min)
- ✅ Logs de auditoría para todas las autenticaciones

## Rate Limits

Mastodon tiene límites de API:
- **300 requests / 5 minutos** por access token
- El bot hace ~1 request cada 30 segundos = ~120 requests/hora
- Bien dentro del límite ✅

## Límites de Caracteres

- Mastodon default: **500 caracteres**
- Bot usa: **450 caracteres** (margen de seguridad)
- Si respuesta excede: trunca con "..."

## Próximas Mejoras (Opcional)

- [ ] Posteo autónomo programado
- [ ] Responder a replies de sus propios toots
- [ ] Boost/Favorite inteligente
- [ ] Detección de idioma automática
- [ ] Media attachments (imágenes)
- [ ] Hashtag monitoring
- [ ] WebSocket en vez de polling

## Soporte

Para problemas o preguntas, revisar:
1. Logs del bot: `npm run dev:mastodon`
2. Logs del API: `npm run dev:api`
3. Estado de la aplicación en Mastodon: `https://alia.onl/settings/applications`

## Licencia

ISC
