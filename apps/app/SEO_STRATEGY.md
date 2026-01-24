# 🚀 Estrategia SEO Completa para Alia by Oxy (2026)

**Objetivo**: Posicionar Alia en los primeros resultados de Google y generar tráfico orgánico masivo compitiendo con ChatGPT, Claude y Gemini.

---

## ✅ FASE 1: FUNDAMENTOS SEO TÉCNICO (COMPLETADO)

### Implementado

1. **✅ Sitemap Dinámico Automático**
   - Archivo: `apps/app/scripts/generate-sitemap.ts`
   - Genera sitemap.xml con todas las rutas (estáticas y dinámicas)
   - Ejecutar: `npm run generate-sitemap` (añadir script a package.json)
   - Actualización automática recomendada: cada build o deploy

2. **✅ Robots.txt Optimizado**
   - Archivo: `apps/app/public/robots.txt`
   - Bloquea rutas privadas (/settings, /billing, /c/)
   - Permite crawling de contenido público
   - Bloquea bots de scraping agresivos (Ahrefs, Semrush)
   - Múltiples sitemaps declarados

3. **✅ Meta Tags Dinámicos + Open Graph**
   - Archivo: `apps/app/lib/seo/meta-tags.ts`
   - Sistema completo de meta tags por página
   - Open Graph para compartir en redes sociales
   - Twitter Cards
   - Hreflang tags para i18n
   - Presets predefinidos para páginas comunes

4. **✅ Componente SEOHead Reutilizable**
   - Archivo: `apps/app/components/seo/SEOHead.tsx`
   - Uso: `<SEOHead {...META_PRESETS.home} />`
   - Integración perfecta con Expo Router

5. **✅ Structured Data (Schema.org)**
   - Archivo: `apps/app/lib/seo/structured-data.ts`
   - WebApplication schema
   - SoftwareApplication schema
   - FAQ schema
   - Article schema (blog)
   - Breadcrumb schema
   - HowTo schema
   - Product schema (comparaciones)

6. **✅ Landing Pages SEO-Optimizadas**
   - `/ai-chat` - Keywords: "ai chat", "chat with ai"
   - `/features` - Features con FAQ structured data
   - `/pricing` - Pricing con FAQ
   - `/vs/chatgpt` - Comparison page (alto valor SEO)

---

## 🎯 KEYWORDS ESTRATÉGICAS (2026)

### Keywords Primarias (Alto volumen)
| Keyword | Volumen mensual | Dificultad | Prioridad |
|---------|----------------|------------|-----------|
| ai chat | 450K | Alta | 🔴 Crítica |
| chatbot ai | 301K | Alta | 🔴 Crítica |
| ai assistant | 246K | Alta | 🔴 Crítica |
| chatgpt alternative | 90K | Media-Alta | 🟡 Alta |
| free ai chat | 165K | Media | 🟡 Alta |

### Keywords Long-tail (Menor competencia, mejor conversión)
| Keyword | Volumen | Dificultad | Prioridad |
|---------|---------|------------|-----------|
| ai chat for coding | 18K | Media | 🟢 Media |
| multilingual ai chatbot | 8K | Baja | 🟢 Media |
| ai assistant with memory | 12K | Baja-Media | 🟡 Alta |
| chatbot for developers | 14K | Media | 🟢 Media |
| openai api alternative | 6K | Baja | 🟢 Media |

### Comparison Keywords (Conversión alta)
- "alia vs chatgpt" (creciendo)
- "alia vs claude" (creciendo)
- "chatgpt vs claude vs gemini" (85K - crear contenido)

---

## 📋 FASE 2: IMPLEMENTACIÓN PRIORITARIA (PRÓXIMOS PASOS)

### 1. Actualizar Home Page con SEO

**Archivo**: `apps/app/app/(app)/index.tsx`

```tsx
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import { STRUCTURED_DATA_PRESETS } from '@/lib/seo/structured-data';

export default function Home() {
  return (
    <>
      <SEOHead {...META_PRESETS.home}>
        <StructuredData data={STRUCTURED_DATA_PRESETS.homepage} />
      </SEOHead>
      {/* ... resto del contenido */}
    </>
  );
}
```

### 2. Añadir SEO a Todas las Páginas Existentes

**Patrón a seguir**:

```tsx
// En cada página:
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

export default function MyPage() {
  return (
    <>
      <SEOHead
        title="Título único y descriptivo"
        description="Descripción de 155-160 caracteres"
        keywords={['keyword1', 'keyword2']}
        canonicalUrl="https://alia.onl/my-page"
      />
      {/* contenido */}
    </>
  );
}
```

**Páginas a actualizar**:
- ✅ `/` (Home) - META_PRESETS.home
- ✅ `/login` - META_PRESETS.login
- ✅ `/register` - META_PRESETS.register
- `/developers` - META_PRESETS.developers
- `/developers/documentation` - META_PRESETS.developers
- `/roles` - Crear preset personalizado
- `/library` - Crear preset personalizado

### 3. Crear Páginas de Comparación Adicionales

**Alta prioridad para SEO**:

```bash
# Crear estas páginas:
apps/app/app/vs/claude.tsx
apps/app/app/vs/gemini.tsx
apps/app/app/vs/copilot.tsx
```

Usar `/vs/chatgpt.tsx` como template.

### 4. Implementar Blog con Artículos SEO

**Estructura recomendada**:

```
apps/app/app/blog/
├── index.tsx                   (Listado de artículos)
├── [slug].tsx                  (Artículo individual)
└── _posts/
    ├── best-ai-chat-2026.md
    ├── chatgpt-alternatives.md
    ├── ai-for-coding.md
    ├── alia-tutorial-beginners.md
    └── ...
```

**Posts recomendados (long-tail keywords)**:
1. "Best AI Chat Tools in 2026" (keyword: best ai chat)
2. "Top ChatGPT Alternatives" (keyword: chatgpt alternatives)
3. "How to Use AI for Coding" (keyword: ai for coding)
4. "AI Chatbots with Memory: Complete Guide" (keyword: ai with memory)
5. "Alia Tutorial for Beginners" (keyword: alia tutorial)

### 5. OG Images Dinámicas

**Implementar generador de Open Graph images**:

Opciones:
- **Vercel OG**: `@vercel/og` (solo si usas Vercel)
- **Serverless con Playwright**: Genera imágenes on-demand
- **Pre-generadas**: Para páginas estáticas

**Estructura**:

```typescript
// apps/app/app/api/og/route.ts
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title');

  // Generar imagen con título dinámico
  return new ImageResponse(...);
}
```

**Actualizar meta-tags.ts**:

```typescript
export function generateOGImageURL(params: {
  title: string;
  subtitle?: string;
}) {
  return `https://alia.onl/api/og?title=${encodeURIComponent(params.title)}`;
}
```

---

## 🌍 FASE 3: SEO MULTILINGÜE (i18n Avanzado)

Tu app ya tiene i18n con `i18n-js`. Ahora necesitas SEO multilingüe.

### Implementar Hreflang Tags

**El sistema ya está preparado en `meta-tags.ts`**. Solo falta usarlo:

```tsx
// Ejemplo en /ai-chat
<SEOHead
  {...META_PRESETS.aiChat}
  locale="en-US"
  alternateLocales={[
    { locale: 'es-ES', url: 'https://alia.onl/es/ai-chat' },
    { locale: 'fr-FR', url: 'https://alia.onl/fr/ai-chat' },
    { locale: 'de-DE', url: 'https://alia.onl/de/ai-chat' },
  ]}
/>
```

### Estrategia de URLs Multilingüe

**Opción A: Subdirectorios** (Recomendado)
```
https://alia.onl/          (inglés, default)
https://alia.onl/es/       (español)
https://alia.onl/fr/       (francés)
https://alia.onl/de/       (alemán)
```

**Opción B: Subdominos**
```
https://alia.onl/          (inglés)
https://es.alia.onl/       (español)
https://fr.alia.onl/       (francés)
```

**Implementación con Expo Router**:

Crear estructura:
```
apps/app/app/[locale]/
├── _layout.tsx
├── index.tsx
├── ai-chat.tsx
├── features.tsx
└── ...
```

---

## ⚡ FASE 4: CORE WEB VITALS & PERFORMANCE

### Optimizaciones Críticas

1. **Code Splitting**

```tsx
// Lazy load heavy components
import { lazy, Suspense } from 'react';

const HeavyComponent = lazy(() => import('@/components/HeavyComponent'));

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <HeavyComponent />
    </Suspense>
  );
}
```

2. **Image Optimization**

```tsx
import { Image } from 'expo-image';

// Usar Expo Image con optimizaciones
<Image
  source={{ uri: 'https://...' }}
  contentFit="cover"
  transition={200}
  placeholder={blurhash}
/>
```

3. **Font Preloading**

Ya está en `+html.tsx`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="dns-prefetch" href="https://fonts.gstatic.com" />
```

4. **Reducir JavaScript Bundle**

```bash
# Analizar bundle
npx expo export --platform web --clear
npx source-map-explorer 'dist/**/*.js'
```

5. **Lazy Routes** (Expo Router feature)

```tsx
// app/_layout.tsx
export const unstable_settings = {
  initialRouteName: '(app)',
  // Expo Router ya hace lazy loading automático de rutas
};
```

---

## 📊 FASE 5: MONITOREO Y ANALYTICS

### Google Search Console

1. Verificar propiedad en: https://search.google.com/search-console
2. Enviar sitemap: `https://alia.onl/sitemap.xml`
3. Monitorear:
   - Impresiones y clicks
   - CTR por query
   - Páginas mejor posicionadas
   - Errores de indexación

### Google Analytics 4

**Añadir a `+html.tsx`**:

```tsx
{/* Google Analytics */}
<script
  async
  src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"
/>
<script
  dangerouslySetInnerHTML={{
    __html: `
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-XXXXXXXXXX');
    `,
  }}
/>
```

### Web Vitals Monitoring

```bash
npm install web-vitals
```

```tsx
// lib/analytics/web-vitals.ts
import { onCLS, onFID, onFCP, onLCP, onTTFB } from 'web-vitals';

export function reportWebVitals() {
  onCLS(console.log);
  onFID(console.log);
  onFCP(console.log);
  onLCP(console.log);
  onTTFB(console.log);
}
```

---

## 📝 ESTRATEGIA DE CONTENIDO LONG-TAIL

### Blog Post Ideas (Alto impacto SEO)

1. **"10 Best ChatGPT Alternatives in 2026"**
   - Target: "chatgpt alternatives" (90K vol)
   - Incluir Alia en posición #1 o #2
   - Comparación honesta con pros/cons

2. **"AI Chat for Developers: Complete Guide"**
   - Target: "ai for developers", "coding ai" (18K vol)
   - Showcasear API de Alia
   - Ejemplos de código

3. **"Free AI Chat Tools: Which One is Best?"**
   - Target: "free ai chat" (165K vol)
   - Comparar planes gratuitos
   - CTA a registro de Alia

4. **"How to Use AI Chatbots Effectively"**
   - Target: "how to use ai chatbot" (35K vol)
   - Tutorial práctico
   - Ejemplos con Alia

5. **"ChatGPT vs Claude vs Gemini vs Alia"**
   - Target: "chatgpt vs claude vs gemini" (85K vol)
   - Mega comparison
   - Tabla comparativa detallada

---

## 🎯 QUICK WINS (Implementar Ya)

### 1. Actualizar package.json

```json
{
  "scripts": {
    "generate-sitemap": "tsx apps/app/scripts/generate-sitemap.ts",
    "build:web": "npm run generate-sitemap && npm run build",
    "prebuild": "npm run generate-sitemap"
  }
}
```

### 2. Crear OG Image Default

Diseñar y añadir:
- `apps/app/public/og-image-default.png` (1200x630px)
- Marca Alia
- Tagline: "Chat with AI that remembers"

### 3. Añadir Breadcrumbs UI

```tsx
// components/Breadcrumbs.tsx
export function Breadcrumbs({ items }: { items: Array<{name: string, href: string}> }) {
  return (
    <nav aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={index}>
          {index > 0 && ' / '}
          <Link href={item.href}>{item.name}</Link>
        </span>
      ))}
    </nav>
  );
}
```

### 4. Actualizar +html.tsx con Canonical

```tsx
// apps/app/app/+html.tsx
<link rel="canonical" href="https://alia.onl/" />
```

---

## 📈 MÉTRICAS DE ÉXITO

### KPIs a Monitorear (Mensual)

| Métrica | Objetivo Mes 1 | Objetivo Mes 3 | Objetivo Mes 6 |
|---------|----------------|----------------|----------------|
| Tráfico orgánico | 1K visitas | 10K visitas | 50K+ visitas |
| Keywords posicionadas (Top 10) | 5 keywords | 20 keywords | 50+ keywords |
| Backlinks | 10 | 50 | 200+ |
| Domain Authority | 15 | 25 | 35+ |
| Conversión orgánica | 2% | 3% | 5%+ |

### Herramientas de Tracking

- **Google Search Console**: Posiciones y CTR
- **Google Analytics 4**: Tráfico y conversiones
- **Ahrefs / Semrush**: Keywords y competencia
- **PageSpeed Insights**: Core Web Vitals
- **Hotjar**: Behavior analytics (opcional)

---

## 🔗 LINK BUILDING STRATEGY

### Tácticas de Alto Impacto

1. **Product Hunt Launch**
   - Lanzar en Product Hunt
   - Objetivo: Backlink + tráfico inicial
   - Preparar demo video

2. **Developer Communities**
   - Post en Dev.to, Hashnode, Medium
   - Tutorial: "Build with Alia API"
   - Backlinks de alta calidad

3. **AI Tools Directories**
   - Enviar a directorios:
     - There's An AI For That
     - Future Tools
     - AI Tool Guru
     - Futurepedia

4. **Guest Posting**
   - Escribir para blogs de AI/Tech
   - Tema: "Future of conversational AI"
   - Backlink a alia.onl

5. **Open Source**
   - Liberar SDKs en GitHub
   - NPM packages
   - Documentación bien linkeda

---

## 🚨 ERRORES A EVITAR

### ❌ NO hacer:

1. **Keyword Stuffing**: Títulos limpios (ver actualización)
2. **Duplicate Content**: Cada página única
3. **Thin Content**: Mínimo 300 palabras por página
4. **Missing Alt Text**: Todas las imágenes con alt
5. **Slow Loading**: Core Web Vitals crítico
6. **Mobile Issues**: Mobile-first siempre
7. **Broken Links**: Verificar regularmente
8. **No SSL**: HTTPS obligatorio
9. **Ignored Search Console**: Revisar semanalmente
10. **Black Hat SEO**: Nunca comprar links

---

## ✨ RESUMEN EJECUTIVO

### ✅ Completado (Fase 1)

- Sitemap dinámico
- Robots.txt optimizado
- Sistema de meta tags
- Componentes SEO reutilizables
- Schema.org estructurado
- Landing pages: /ai-chat, /features, /pricing
- Página comparación: /vs/chatgpt

### 🔜 Siguiente (Prioridad Alta)

1. Actualizar home page con SEO
2. Crear /vs/claude y /vs/gemini
3. Implementar blog con 5 artículos
4. Generar OG images dinámicas
5. Code splitting y performance
6. Google Search Console setup

### 📆 Roadmap (3 meses)

**Mes 1**: Fundamentos técnicos + contenido inicial
**Mes 2**: Blog activo + link building + i18n
**Mes 3**: Optimización continua + expansión contenido

---

## 🎓 RECURSOS ADICIONALES

- [Google Search Central](https://developers.google.com/search)
- [Schema.org](https://schema.org/)
- [Web.dev](https://web.dev/) - Core Web Vitals
- [Ahrefs Academy](https://ahrefs.com/academy) - SEO training
- [Expo SEO Guide](https://docs.expo.dev/guides/seo/)

---

**Última actualización**: 2026-01-24
**Siguiente revisión**: 2026-02-24

