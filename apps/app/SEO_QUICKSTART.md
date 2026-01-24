# 🚀 SEO Quick Start - Alia by Oxy

Pasos inmediatos para activar el SEO en tu app Expo 54.

---

## ✅ PASO 1: Instalar Dependencias (si faltan)

```bash
cd apps/app
npm install
```

Todo el código SEO ya está creado y no requiere dependencias adicionales.

---

## ✅ PASO 2: Añadir Script para Sitemap

Edita `apps/app/package.json`:

```json
{
  "scripts": {
    "generate-sitemap": "tsx scripts/generate-sitemap.ts",
    "build": "npm run generate-sitemap && expo export --platform web",
    "build:production": "npm run generate-sitemap && NODE_ENV=production EXPO_UNSTABLE_TREE_SHAKING=1 EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 expo export --platform web --clear"
  }
}
```

Instala `tsx` si no lo tienes:

```bash
npm install -D tsx
```

---

## ✅ PASO 3: Generar Sitemap Inicial

```bash
npm run generate-sitemap
```

Esto creará:
- `apps/app/public/sitemap.xml`
- `apps/app/dist/sitemap.xml` (si dist existe)

Verifica que el sitemap se generó correctamente:

```bash
cat apps/app/public/sitemap.xml
```

---

## ✅ PASO 4: Actualizar Home Page con SEO

Edita [apps/app/app/(app)/index.tsx](apps/app/app/(app)/index.tsx):

```tsx
import { SEOHead } from '@/components/seo/SEOHead';
import { StructuredData } from '@/components/seo/StructuredData';
import { META_PRESETS } from '@/lib/seo/meta-tags';
import { STRUCTURED_DATA_PRESETS } from '@/lib/seo/structured-data';

export default function ChatHome() {
  return (
    <>
      <SEOHead {...META_PRESETS.home}>
        <StructuredData data={STRUCTURED_DATA_PRESETS.homepage} />
      </SEOHead>

      {/* ... resto de tu código */}
    </>
  );
}
```

---

## ✅ PASO 5: Añadir SEO a Login y Register

### Login - [apps/app/app/(app)/login.tsx](apps/app/app/(app)/login.tsx)

```tsx
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

export default function Login() {
  return (
    <>
      <SEOHead {...META_PRESETS.login} />
      {/* ... tu código */}
    </>
  );
}
```

### Register - [apps/app/app/(app)/register.tsx](apps/app/app/(app)/register.tsx)

```tsx
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

export default function Register() {
  return (
    <>
      <SEOHead {...META_PRESETS.register} />
      {/* ... tu código */}
    </>
  );
}
```

---

## ✅ PASO 6: Añadir SEO a Developers Pages

### Developers Home - [apps/app/app/(developers)/developers/index.tsx](apps/app/app/(developers)/developers/index.tsx)

```tsx
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

export default function DevelopersHome() {
  return (
    <>
      <SEOHead {...META_PRESETS.developers} />
      {/* ... tu código */}
    </>
  );
}
```

---

## ✅ PASO 7: Crear OG Image Default

Diseña una imagen 1200x630px con:
- Logo de Alia
- Tagline: "Chat with AI that remembers"
- Colores de marca (#ca52e9)

Guárdala como:
```
apps/app/public/og-image-default.png
```

Herramientas recomendadas:
- Figma (gratis)
- Canva (gratis)
- Photopea (gratis, online)

---

## ✅ PASO 8: Actualizar Twitter Handle

Edita [apps/app/lib/seo/meta-tags.ts](apps/app/lib/seo/meta-tags.ts):

```typescript
const TWITTER_HANDLE = '@TuTwitterHandle'; // Actualizar con tu handle real
```

---

## ✅ PASO 9: Verificar Rutas Nuevas

Las siguientes rutas SEO ya están creadas:

- ✅ `/ai-chat` - Landing page optimizada
- ✅ `/features` - Features con FAQ
- ✅ `/pricing` - Pricing con FAQ
- ✅ `/vs/chatgpt` - Comparison page

Asegúrate de que estas rutas sean accesibles navegando a:
```
http://localhost:8081/ai-chat
http://localhost:8081/features
http://localhost:8081/pricing
http://localhost:8081/vs/chatgpt
```

---

## ✅ PASO 10: Build y Deploy

```bash
# Build para web
npm run build:production

# Verifica que el sitemap esté en dist
ls -la dist/sitemap.xml
ls -la dist/robots.txt
```

Deploy a tu hosting (Vercel, Netlify, Cloudflare Pages, etc.)

---

## 🔍 VERIFICACIÓN POST-DEPLOY

### 1. Verifica que el sitemap sea accesible

```bash
curl https://alia.onl/sitemap.xml
```

### 2. Verifica robots.txt

```bash
curl https://alia.onl/robots.txt
```

### 3. Verifica meta tags en una página

Navega a https://alia.onl/ai-chat y haz "View Source". Deberías ver:

```html
<title>Chat with AI - Alia</title>
<meta name="description" content="..." />
<meta property="og:title" content="..." />
<script type="application/ld+json">
  {...}
</script>
```

### 4. Testea Open Graph

Usa estas herramientas:
- **Facebook Debugger**: https://developers.facebook.com/tools/debug/
- **Twitter Card Validator**: https://cards-dev.twitter.com/validator
- **LinkedIn Inspector**: https://www.linkedin.com/post-inspector/

---

## 📊 SIGUIENTE: Google Search Console

1. Ve a: https://search.google.com/search-console
2. Añade tu propiedad: `https://alia.onl`
3. Verifica propiedad (método DNS o HTML file)
4. Envía sitemap: `https://alia.onl/sitemap.xml`

---

## 🐛 TROUBLESHOOTING

### Problema: Sitemap no se genera

**Solución**:
```bash
# Ejecuta manualmente
npx tsx apps/app/scripts/generate-sitemap.ts

# Verifica permisos de escritura
ls -la apps/app/public/
```

### Problema: Meta tags no aparecen

**Solución**:
- Verifica que importaste `SEOHead` correctamente
- Asegúrate de que esté dentro del componente (antes del return)
- Revisa la consola del navegador por errores

### Problema: OG image no se muestra

**Solución**:
- Verifica que `og-image-default.png` existe en `/public`
- Verifica que la ruta es absoluta: `https://alia.onl/og-image-default.png`
- Limpia caché de Facebook/Twitter debugger

---

## 🎯 PRÓXIMOS PASOS RECOMENDADOS

Después de completar este Quick Start:

1. **Crear páginas de comparación adicionales**:
   - `/vs/claude.tsx` (copiar de `/vs/chatgpt.tsx`)
   - `/vs/gemini.tsx`

2. **Implementar blog**:
   - Crear `/app/blog/` directory
   - Añadir primer artículo

3. **Optimizar performance**:
   - Revisar bundle size
   - Implementar lazy loading
   - Optimizar imágenes

4. **Monitorear métricas**:
   - Google Search Console
   - Google Analytics 4
   - Core Web Vitals

---

## 📚 DOCUMENTACIÓN COMPLETA

Para la estrategia SEO completa, ver:
- [SEO_STRATEGY.md](SEO_STRATEGY.md) - Estrategia completa, keywords, roadmap

---

## ✅ CHECKLIST COMPLETO

- [ ] Instalé dependencias
- [ ] Añadí script `generate-sitemap` a package.json
- [ ] Generé sitemap inicial
- [ ] Actualicé home page con SEO
- [ ] Añadí SEO a login/register
- [ ] Añadí SEO a developers pages
- [ ] Creé OG image default
- [ ] Actualicé Twitter handle
- [ ] Verifiqué rutas nuevas funcionan
- [ ] Hice build de producción
- [ ] Deploy a producción
- [ ] Verifiqué sitemap en producción
- [ ] Verifiqué meta tags en producción
- [ ] Testeé Open Graph
- [ ] Configuré Google Search Console
- [ ] Envié sitemap a Google

---

**¡Listo!** Con estos pasos, tu app Expo 54 tendrá una base SEO sólida y profesional.

Siguiente: [SEO_STRATEGY.md](SEO_STRATEGY.md) para el plan completo.

