# Alia API

API standalone de Alia construida con Express y TypeScript.

## Características

- API RESTful con Express
- Conexión a MongoDB con Mongoose
- Soporte para múltiples proveedores de IA (OpenAI, Anthropic, Google)
- Autenticación y gestión de usuarios
- Chat streaming
- API compatible con OpenAI

## Desarrollo

```bash
# Desde el root del monorepo
npm run dev:api

# O desde apps/api
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Variables de Entorno

Crea un archivo `.env` en `apps/api/`:

```env
API_PORT=3001
NODE_ENV=development
MONGODB_URI='mongodb://localhost:27017/alia'
WEB_URL='http://localhost:3000'

# API Keys
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Auth
NEXTAUTH_SECRET=
NEXTAUTH_URL='http://localhost:3001'
```

## Endpoints

- `GET /api` - Información de la API
- `GET /api/health` - Health check
- `POST /api/auth/register` - Registro de usuarios
- `POST /api/auth/forgot-password` - Recuperar contraseña
- `POST /api/auth/reset-password` - Restablecer contraseña
- `GET /api/conversations` - Listar conversaciones
- `POST /api/conversations` - Crear conversación
- `GET /api/conversations/:id` - Obtener conversación
- `PUT /api/conversations/:id` - Actualizar conversación
- `DELETE /api/conversations/:id` - Eliminar conversación
- `GET /api/folders` - Listar carpetas
- `POST /api/folders` - Crear carpeta
- `DELETE /api/folders/:id` - Eliminar carpeta
- `POST /api/alia/chat` - Chat streaming
- `POST /api/v1/chat/completions` - Chat completions (compatible OpenAI)
- `GET /api/v1/models` - Listar modelos disponibles

## Estructura

```
src/
├── index.ts          # Punto de entrada
├── routes/           # Rutas de la API
│   ├── health.ts
│   ├── auth.ts
│   ├── conversations.ts
│   ├── folders.ts
│   ├── chat.ts
│   ├── v1.ts
│   └── v1/
│       ├── chat-completions.ts
│       └── models.ts
├── models/           # Modelos de MongoDB
└── lib/              # Utilidades y providers
```

## TODO

Las siguientes funcionalidades necesitan ser migradas desde las API routes de Next.js:

- [ ] Lógica de autenticación (registro, login, reset password)
- [ ] CRUD de conversaciones
- [ ] CRUD de folders
- [ ] Chat streaming con AI providers
- [ ] API v1 compatible con OpenAI
