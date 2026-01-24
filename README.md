# 🤖 Alia

Alia es una plataforma avanzada de agentes de IA diseñada para potenciar la productividad y automatizar flujos de trabajo mediante expertos especializados.

🌐 **Dominio oficial:** [alia.onl](https://alia.onl)

## 🚀 Agentes de Alia

Alia no es solo una IA, es un equipo de expertos a tu disposición:
- **Alia**: El asistente general inteligente.
- **Alia Developer**: Especializado en arquitectura de software, debugging y desarrollo.
- **Alia Social Manager**: Experto en estrategia de contenido y redes sociales.
- **Alia Business**: Analista estratégico de mercado y negocios.

## ✨ Características Principal

- **Multiaplicación**: Accede a distintos perfiles de IA según tu necesidad.
- **Interfaz Fluida**: Chat optimizado con entrada de comandos persistente.
- **Administración Inteligente**: Gestión avanzada de modelos y proveedores.
- **Privacidad y Control**: Datos seguros y gestión de acceso.

## 📁 Estructura del Proyecto

Este proyecto está organizado como un monorepo con tres aplicaciones principales:

```
/
├── apps/
│   ├── app/          # Expo (web + iOS + Android) - Aplicación principal
│   ├── api/          # API standalone (Express)
│   └── admin/        # Next.js - Panel de administración
├── packages/
│   └── shared/       # Código compartido (tipos, utilidades)
└── package.json      # Root monorepo
```

**apps/app** es la aplicación principal de Alia que funciona en:
- 🌐 **Web** - Versión web con Expo for Web
- 📱 **iOS** - App nativa con Expo
- 🤖 **Android** - App nativa con Expo

**apps/admin** es el panel de administración (Next.js) solo para gestión interna.

## ⚙️ Instalación

### 1. Instalar dependencias del monorepo
```bash
npm install
```

### 2. Configurar variables de entorno

**Para la App principal** (`apps/app/lib/config.ts`):
La configuración de URLs está en el código para diferentes entornos (dev, staging, prod).

**Para el Admin** (`apps/admin/.env`):
```env
MONGODB_URI='mongodb://localhost:27017/alia'
NEXTAUTH_SECRET='tu-secret-key'
NEXTAUTH_URL='http://localhost:3000'
# API Keys de proveedores
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

**Para la API** (`apps/api/.env`):
```env
API_PORT=3001
MONGODB_URI='mongodb://localhost:27017/alia'
WEB_URL='http://localhost:3000'
# API Keys de proveedores
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

### 3. Iniciar el proyecto

**Todas las aplicaciones en paralelo:**
```bash
npm run dev
```

**O iniciar cada aplicación individualmente:**

```bash
# App principal (Expo - web + mobile)
npm run dev:app

# API Server (Express)
npm run dev:api

# Panel Admin (Next.js)
npm run dev:admin
```

## 📱 Desarrollo de la App

Para ejecutar la app principal en diferentes plataformas:

```bash
# Desde el root
npm run web       # Web (http://localhost:8081)
npm run android   # Android
npm run ios       # iOS (requiere macOS)

# O desde apps/app
cd apps/app
npm start         # Expo DevTools
npm run web       # Solo web
npm run android   # Solo Android
npm run ios       # Solo iOS
```

## 🔨 Scripts Disponibles

### Desarrollo
- `npm run dev` - Iniciar todas las apps en modo desarrollo
- `npm run dev:app` - Iniciar solo la app (Expo)
- `npm run dev:api` - Iniciar solo la API
- `npm run dev:admin` - Iniciar solo el admin

### Plataformas (App)
- `npm run web` - App en web
- `npm run android` - App en Android
- `npm run ios` - App en iOS

### Build
- `npm run build` - Compilar todas las apps
- `npm run build:app` - Compilar la app
- `npm run build:api` - Compilar la API
- `npm run build:admin` - Compilar el admin

### Producción
- `npm run start:app` - Iniciar app en producción
- `npm run start:api` - Iniciar API en producción
- `npm run start:admin` - Iniciar admin en producción

## 🔌 API y Extensibilidad

Alia permite la integración de nuevos agentes y la conexión con múltiples proveedores de LLM de forma transparente para el usuario final.

### Endpoints de la API

La API standalone expone los siguientes endpoints:

- `/api/health` - Estado del servidor
- `/api/auth` - Autenticación y registro
- `/api/conversations` - Gestión de conversaciones
- `/api/folders` - Gestión de carpetas
- `/api/alia/chat` - Chat streaming
- `/api/v1` - API compatible con OpenAI

## 📚 Documentación de cada app

- [apps/app/README.md](apps/app/README.md) - Aplicación principal (Expo)
- [apps/api/README.md](apps/api/README.md) - API Server
- [apps/admin/README.md](apps/admin/README.md) - Panel de administración

## 📖 Documentación Técnica

- [MEMORY_SYSTEM.md](MEMORY_SYSTEM.md) - Sistema de memoria completo (API, export/import, límites por plan)
- [DEPLOYMENT.md](DEPLOYMENT.md) - Guía de despliegue a producción (DigitalOcean, variables de entorno, troubleshooting)
- [CHANGELOG.md](CHANGELOG.md) - Registro de cambios y mejoras

---
© 2026 Alia - The Agent Era
Hello