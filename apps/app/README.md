# Alia App

Aplicación principal de Alia construida con Expo Router y React Native. Funciona en web, iOS y Android.

## 🚀 Características

- **Expo Router** - File-based routing como Next.js
- **AI SDK** - Integración con @ai-sdk/react para chat streaming
- **NativeWind** - Tailwind CSS para React Native
- **Hugeicons** - Mismos iconos que el admin
- **UI Consistente** - Componentes basados en shadcn/ui adaptados a RN
- **Multi-plataforma** - Una sola base de código para web, iOS y Android

## 📁 Estructura de Rutas

```
app/
├── index.tsx         # Redirección inicial
├── login.tsx         # /login - Pantalla de login
├── register.tsx      # /register - Pantalla de registro
└── (chat)/
    └── index.tsx     # /chat - Pantalla de chat principal
```

## ⚙️ Desarrollo

### Iniciar el servidor de desarrollo:

```bash
# Desde el root del monorepo
npm run dev:app

# O desde apps/app
npm start
```

### Ejecutar en plataformas específicas:

```bash
# Desde el root
npm run web       # Web
npm run android   # Android
npm run ios       # iOS

# O desde apps/app
npm run web
npm run android
npm run ios
```

## 🔧 Configuración

### URL de la API

La configuración de la URL de la API se encuentra en [lib/config.ts](lib/config.ts):

- **Desarrollo**: `http://localhost:3000`
- **Staging**: `https://staging-api.alia.onl`
- **Producción**: `https://api.alia.onl`

Para desarrollo local, asegúrate de que la API esté corriendo en `http://localhost:3000`.

## 🎨 Componentes UI

Los componentes están en [components/ui/](components/ui/) y están diseñados para ser compatibles con React Native mientras mantienen la API de shadcn/ui:

- `Button` - Botones con variantes (default, outline, ghost, etc.)
- `Input` - Campos de texto estilizados

## 📱 Pantallas

### Login ([app/login.tsx](app/login.tsx))
- Formulario de autenticación
- Validación de email y contraseña
- Navegación a registro

### Register ([app/register.tsx](app/register.tsx))
- Formulario de registro
- Confirmación de contraseña
- Validación de datos

### Chat ([app/(chat)/index.tsx](app/(chat)/index.tsx))
- Integración con `useChat` hook del AI SDK
- Streaming de respuestas en tiempo real
- Renderizado de Markdown
- Auto-scroll a nuevos mensajes
- UI consistente en web y móvil

## 🔌 AI SDK Integration

La app usa el mismo sistema que el admin:

```tsx
const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
  api: `${config.apiUrl}/api/alia/chat`,
});
```

## 📦 Build para Producción

### Configurar EAS:

```bash
# Instalar EAS CLI globalmente
npm install -g eas-cli

# Login
eas login

# Configurar el proyecto
eas build:configure
```

### Crear builds:

```bash
# Android
npm run build:android

# iOS
npm run build:ios

# Ambas plataformas
eas build --platform all
```

## 🌐 Web vs Mobile

Esta aplicación funciona tanto en web como en móvil usando la misma base de código:

- **Web**: Se renderiza con React Native Web (similar a como funciona React Native en web)
- **iOS/Android**: Usa componentes nativos de React Native

## 🎯 TODO

- [ ] Implementar autenticación real con la API
- [ ] Agregar manejo de sesiones (tokens, refresh)
- [ ] Implementar persistencia de conversaciones
- [ ] Agregar modo offline
- [ ] Implementar notificaciones push
- [ ] Agregar tema oscuro/claro
- [ ] Implementar compartir conversaciones
- [ ] Agregar gestión de modelos de IA
- [ ] Implementar carpetas de conversaciones
- [ ] Agregar configuración de usuario

## 📚 Recursos

- [Expo Documentation](https://docs.expo.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/)
- [AI SDK for Expo](https://ai-sdk.dev/docs/getting-started/expo)
- [NativeWind](https://www.nativewind.dev/)
- [Hugeicons React Native](https://hugeicons.com/)
