# ⚡ Performance Optimization - Core Web Vitals para SEO

Google usa Core Web Vitals como factor de ranking. Esta guía optimiza tu app Expo 54 para máxima performance.

---

## 📊 CORE WEB VITALS (2026)

Google mide 3 métricas principales:

| Métrica | Qué mide | Objetivo | Crítico para |
|---------|----------|----------|--------------|
| **LCP** (Largest Contentful Paint) | Velocidad de carga visual | < 2.5s | Ranking |
| **FID** (First Input Delay) | Interactividad | < 100ms | UX |
| **CLS** (Cumulative Layout Shift) | Estabilidad visual | < 0.1 | UX |

**Nuevo en 2026**: **INP** (Interaction to Next Paint) reemplaza FID
- Objetivo: < 200ms

---

## 🚀 OPTIMIZACIONES PRIORITARIAS

### 1. Code Splitting y Lazy Loading

#### A. Lazy Load Components

```tsx
// components/HeavyChat.tsx
import { lazy, Suspense } from 'react';
import { ActivityIndicator } from 'react-native';

const ChatInterface = lazy(() => import('./ChatInterface'));
const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

export function HeavyChat() {
  return (
    <Suspense fallback={<ActivityIndicator />}>
      <ChatInterface />
      <MarkdownRenderer />
    </Suspense>
  );
}
```

#### B. Dynamic Imports

```tsx
// Para componentes que no se usan de inmediato
import dynamic from 'next/dynamic'; // Si usas Next.js con Expo
// O con React.lazy:

const SettingsPanel = lazy(() => import('./SettingsPanel'));
const BillingModule = lazy(() => import('./BillingModule'));
```

#### C. Route-based Code Splitting

Expo Router ya hace esto automáticamente, pero puedes optimizar:

```tsx
// app/_layout.tsx
export const unstable_settings = {
  initialRouteName: '(app)',
  // Expo Router lazy-loads rutas no activas
};
```

---

### 2. Optimización de Imágenes

#### A. Usar Expo Image con Optimizaciones

```tsx
import { Image } from 'expo-image';

export function OptimizedImage({ uri, alt }: { uri: string; alt: string }) {
  return (
    <Image
      source={{ uri }}
      contentFit="cover"
      transition={200}
      placeholder={blurhash} // BlurHash para preview
      cachePolicy="memory-disk" // Cache strategy
      priority="high" // Para imágenes above-the-fold
      alt={alt} // Accessibility + SEO
      style={{ width: '100%', height: 'auto' }}
    />
  );
}
```

#### B. Responsive Images

```tsx
<Image
  source={{
    uri: uri,
    width: 800,
    height: 600,
  }}
  srcSet={[
    { uri: `${uri}?w=400`, width: 400 },
    { uri: `${uri}?w=800`, width: 800 },
    { uri: `${uri}?w=1200`, width: 1200 },
  ]}
/>
```

#### C. Next-gen Formats

Usa WebP o AVIF en lugar de PNG/JPG:

```tsx
const imageUrl = supports.webp
  ? 'image.webp'
  : supports.avif
  ? 'image.avif'
  : 'image.jpg';
```

---

### 3. Reducir Bundle Size

#### A. Analizar Bundle

```bash
# Build con análisis
EXPO_UNSTABLE_TREE_SHAKING=1 \
EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 \
npx expo export --platform web

# Analizar con source-map-explorer
npx source-map-explorer 'dist/**/*.js' --html bundle-report.html
```

#### B. Tree Shaking

Ya habilitado en tu build, pero asegúrate de:

```typescript
// ✅ BIEN - Importación específica
import { useQuery } from '@tanstack/react-query';

// ❌ MAL - Importa todo
import * as ReactQuery from '@tanstack/react-query';
```

#### C. Remover Dependencias Innecesarias

```bash
# Encuentra dependencias no usadas
npx depcheck

# Analiza peso de dependencias
npx cost-of-modules
```

---

### 4. Font Optimization

#### A. Preload Fonts Críticas

Ya está en tu `+html.tsx`, pero optimiza:

```tsx
{/* Preconnect to Google Fonts */}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

{/* Preload font - SOLO las críticas */}
<link
  rel="preload"
  href="/fonts/inter-var.woff2"
  as="font"
  type="font/woff2"
  crossOrigin="anonymous"
/>
```

#### B. font-display: swap

```css
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap; /* Muestra texto inmediatamente con fallback */
  src: url(/fonts/inter-var.woff2) format('woff2');
}
```

---

### 5. Reducir Layout Shift (CLS)

#### A. Especifica Dimensiones de Imágenes

```tsx
// ❌ MAL - Causa layout shift
<Image source={{ uri }} />

// ✅ BIEN - Dimensiones explícitas
<Image
  source={{ uri }}
  style={{ width: 800, height: 600 }}
/>
```

#### B. Reserva Espacio para Contenido Dinámico

```tsx
export function ChatMessage({ loading }: { loading: boolean }) {
  return (
    <View style={{ minHeight: 100 }}> {/* Altura mínima reservada */}
      {loading ? <Skeleton /> : <MessageContent />}
    </View>
  );
}
```

#### C. Skeleton Screens

```tsx
export function MessageSkeleton() {
  return (
    <View className="animate-pulse">
      <View className="h-4 bg-zinc-200 rounded w-3/4 mb-2" />
      <View className="h-4 bg-zinc-200 rounded w-1/2" />
    </View>
  );
}
```

---

### 6. JavaScript Optimization

#### A. Debounce/Throttle Heavy Operations

```tsx
import { useMemo, useCallback } from 'react';
import debounce from 'lodash.debounce';

export function SearchInput() {
  const handleSearch = useCallback(
    debounce((query: string) => {
      // Expensive search operation
      performSearch(query);
    }, 300),
    []
  );

  return <TextInput onChangeText={handleSearch} />;
}
```

#### B. Memo Heavy Components

```tsx
import { memo } from 'react';

export const ChatMessage = memo(({ message }: { message: Message }) => {
  return <View>{/* Render message */}</View>;
});

// Solo re-renderiza si message.id cambia
export const ChatMessageOptimized = memo(
  ({ message }: { message: Message }) => {
    return <View>{/* Render message */}</View>;
  },
  (prevProps, nextProps) => prevProps.message.id === nextProps.message.id
);
```

#### C. useMemo para Computaciones Costosas

```tsx
import { useMemo } from 'react';

export function ConversationList({ messages }: { messages: Message[] }) {
  const sortedMessages = useMemo(
    () => messages.sort((a, b) => b.timestamp - a.timestamp),
    [messages]
  );

  return <FlatList data={sortedMessages} />;
}
```

---

### 7. Network Optimization

#### A. Prefetch Critical Data

```tsx
import { useQueryClient } from '@tanstack/react-query';

export function HomePage() {
  const queryClient = useQueryClient();

  // Prefetch al montar
  useEffect(() => {
    queryClient.prefetchQuery({
      queryKey: ['user'],
      queryFn: fetchUser,
    });
  }, []);
}
```

#### B. HTTP/2 Server Push

En tu servidor (Nginx, Cloudflare):

```nginx
# Nginx config
location / {
  http2_push /main.css;
  http2_push /main.js;
}
```

#### C. Resource Hints

```tsx
{/* Preconnect a API */}
<link rel="preconnect" href="https://api.alia.onl" />

{/* DNS Prefetch para recursos externos */}
<link rel="dns-prefetch" href="https://fonts.googleapis.com" />

{/* Prefetch rutas probables */}
<link rel="prefetch" href="/features" />
<link rel="prefetch" href="/pricing" />
```

---

### 8. Caching Strategy

#### A. Service Worker (PWA)

```typescript
// public/sw.js
const CACHE_NAME = 'alia-v1';
const urlsToCache = [
  '/',
  '/ai-chat',
  '/features',
  '/pricing',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
```

#### B. HTTP Caching Headers

En tu servidor:

```nginx
# Nginx - Cache assets
location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2)$ {
  expires 1y;
  add_header Cache-Control "public, immutable";
}

# HTML - No cache
location ~* \.html$ {
  expires -1;
  add_header Cache-Control "no-cache, no-store, must-revalidate";
}
```

---

### 9. Monitoring Web Vitals

#### A. Implementar Web Vitals SDK

```bash
npm install web-vitals
```

```typescript
// lib/analytics/web-vitals.ts
import { onCLS, onFID, onFCP, onLCP, onTTFB, onINP } from 'web-vitals';

function sendToAnalytics(metric: Metric) {
  // Enviar a Google Analytics
  if (typeof window.gtag !== 'undefined') {
    window.gtag('event', metric.name, {
      value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
      event_category: 'Web Vitals',
      event_label: metric.id,
      non_interaction: true,
    });
  }

  // También puedes enviar a tu propio analytics
  fetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(metric),
  });
}

export function initWebVitals() {
  onCLS(sendToAnalytics);
  onFID(sendToAnalytics);
  onFCP(sendToAnalytics);
  onLCP(sendToAnalytics);
  onTTFB(sendToAnalytics);
  onINP(sendToAnalytics); // Nuevo en 2026
}
```

#### B. Usar en App

```tsx
// app/_layout.tsx
import { useEffect } from 'react';
import { initWebVitals } from '@/lib/analytics/web-vitals';

export default function RootLayout() {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      initWebVitals();
    }
  }, []);

  return <Slot />;
}
```

---

### 10. CDN Configuration

#### A. Cloudflare Settings (Recomendado)

```
✅ Auto Minify: JS, CSS, HTML
✅ Brotli compression
✅ Early Hints (HTTP 103)
✅ Rocket Loader (opcional)
✅ Mirage (optimización de imágenes)
```

#### B. Vercel Config (si usas Vercel)

```json
// vercel.json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/sitemap.xml",
      "destination": "/api/sitemap"
    }
  ]
}
```

---

## 📏 BENCHMARKS OBJETIVO

### Para competir con ChatGPT, Claude, Gemini

| Métrica | ChatGPT | Claude | Gemini | **Alia (Objetivo)** |
|---------|---------|--------|--------|---------------------|
| LCP | 1.8s | 2.1s | 1.9s | **< 1.5s** |
| FID/INP | 45ms | 60ms | 50ms | **< 50ms** |
| CLS | 0.05 | 0.08 | 0.06 | **< 0.05** |
| TTI | 2.5s | 3.1s | 2.8s | **< 2.0s** |
| Bundle Size | 450KB | 380KB | 520KB | **< 350KB** |

---

## 🔍 HERRAMIENTAS DE TESTING

### Online Tools

1. **PageSpeed Insights**: https://pagespeed.web.dev/
   - Métricas reales de usuarios
   - Sugerencias específicas

2. **WebPageTest**: https://www.webpagetest.org/
   - Testing desde múltiples ubicaciones
   - Filmstrip view
   - Waterfall analysis

3. **Lighthouse CI**:
```bash
npm install -g @lhci/cli
lhci autorun --collect.url=https://alia.onl
```

### Browser DevTools

```javascript
// Performance API en console
performance.getEntriesByType('navigation')[0];
performance.getEntriesByType('paint');
```

---

## ✅ CHECKLIST DE PERFORMANCE

- [ ] Code splitting implementado
- [ ] Lazy loading en componentes pesados
- [ ] Imágenes optimizadas (WebP/AVIF)
- [ ] Imágenes con width/height explícitos
- [ ] Fonts preloaded con font-display: swap
- [ ] Bundle < 350KB (gzipped)
- [ ] Skeleton screens para loading
- [ ] Service Worker configurado
- [ ] HTTP/2 habilitado
- [ ] Brotli compression activo
- [ ] CDN configurado
- [ ] Web Vitals monitoreados
- [ ] Cache headers optimizados
- [ ] Resource hints (preconnect, dns-prefetch)
- [ ] LCP < 2.5s
- [ ] CLS < 0.1
- [ ] INP < 200ms

---

## 🎯 QUICK WINS (Implementar Primero)

1. **Habilitar Brotli en Cloudflare** (1 click)
2. **Añadir width/height a todas las imágenes** (2 horas)
3. **Lazy load componentes no críticos** (4 horas)
4. **Implementar Web Vitals tracking** (1 hora)
5. **Optimizar bundle con tree shaking** (2 horas)

**Impacto estimado**: 30-40% mejora en LCP, 50% reducción en bundle size

---

## 📚 RECURSOS

- [Web.dev - Core Web Vitals](https://web.dev/vitals/)
- [Expo Performance](https://docs.expo.dev/guides/analyzing-bundles/)
- [React Performance](https://react.dev/learn/render-and-commit)
- [Chrome DevTools Performance](https://developer.chrome.com/docs/devtools/performance/)

---

**Siguiente**: Implementa estas optimizaciones gradualmente y mide el impacto en Google Search Console.

