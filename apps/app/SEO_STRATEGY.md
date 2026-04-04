# Complete SEO Strategy for Clarity by Oxy (2026)

**Goal**: Position Clarity in the top Google results and generate massive organic traffic competing with ChatGPT, Claude, and Gemini.

---

## Current Status

The following SEO fundamentals are implemented and working in production without React errors:

- **Sitemap generator** - Auto-generates sitemap.xml (`npm run generate-sitemap`)
- **Robots.txt** - Optimized for SEO, blocks private routes and aggressive scraping bots
- **Home page SEO** - Title, description, and Open Graph tags applied
- **Login/Register meta tags** - Basic meta tags in place
- **Simple Head usage pattern** - Using `Head` from `expo-router/head` directly with clean meta tags (avoids complex components and React hydration issues)
- **package.json** - Configured with sitemap script

Available SEO helper files (for advanced usage when needed):
- `lib/seo/meta-tags.ts` - Meta tag presets and helpers
- `lib/seo/structured-data.ts` - Schema.org JSON-LD helpers

---

## PHASE 1: TECHNICAL SEO FOUNDATIONS (COMPLETED)

### Implemented

1. **Automatic Dynamic Sitemap**
   - File: `apps/app/scripts/generate-sitemap.ts`
   - Generates sitemap.xml with all routes (static and dynamic)
   - Run: `npm run generate-sitemap` (add script to package.json)
   - Recommended automatic update: every build or deploy

2. **Optimized Robots.txt**
   - File: `apps/app/public/robots.txt`
   - Blocks private routes (/settings, /billing, /c/)
   - Allows crawling of public content
   - Blocks aggressive scraping bots (Ahrefs, Semrush)
   - Multiple sitemaps declared

3. **Dynamic Meta Tags + Open Graph**
   - File: `apps/app/lib/seo/meta-tags.ts`
   - Complete per-page meta tag system
   - Open Graph for social media sharing
   - Twitter Cards
   - Hreflang tags for i18n
   - Predefined presets for common pages

4. **Reusable SEOHead Component**
   - File: `apps/app/components/seo/SEOHead.tsx`
   - Usage: `<SEOHead {...META_PRESETS.home} />`
   - Seamless integration with Expo Router

5. **Structured Data (Schema.org)**
   - File: `apps/app/lib/seo/structured-data.ts`
   - WebApplication schema
   - SoftwareApplication schema
   - FAQ schema
   - Article schema (blog)
   - Breadcrumb schema
   - HowTo schema
   - Product schema (comparisons)

6. **SEO-Optimized Landing Pages**
   - `/ai-chat` - Keywords: "ai chat", "chat with ai"
   - `/features` - Features with FAQ structured data
   - `/pricing` - Pricing with FAQ
   - `/vs/chatgpt` - Comparison page (high SEO value)

---

## STRATEGIC KEYWORDS (2026)

### Primary Keywords (High Volume)
| Keyword | Monthly Volume | Difficulty | Priority |
|---------|----------------|------------|----------|
| ai chat | 450K | High | Critical |
| chatbot ai | 301K | High | Critical |
| ai assistant | 246K | High | Critical |
| chatgpt alternative | 90K | Medium-High | High |
| free ai chat | 165K | Medium | High |

### Long-tail Keywords (Lower Competition, Better Conversion)
| Keyword | Volume | Difficulty | Priority |
|---------|--------|------------|----------|
| ai chat for coding | 18K | Medium | Medium |
| multilingual ai chatbot | 8K | Low | Medium |
| ai assistant with memory | 12K | Low-Medium | High |
| chatbot for developers | 14K | Medium | Medium |
| openai api alternative | 6K | Low | Medium |

### Comparison Keywords (High Conversion)
- "clarity vs chatgpt" (growing)
- "clarity vs claude" (growing)
- "chatgpt vs claude vs gemini" (85K - create content)

---

## PHASE 2: PRIORITY IMPLEMENTATION (NEXT STEPS)

### 1. Update Home Page with SEO

**File**: `apps/app/app/(app)/index.tsx`

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
      {/* ... rest of content */}
    </>
  );
}
```

### 2. Add SEO to All Existing Pages

**Pattern to follow**:

```tsx
// In each page:
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

export default function MyPage() {
  return (
    <>
      <SEOHead
        title="Unique and descriptive title"
        description="Description of 155-160 characters"
        keywords={['keyword1', 'keyword2']}
        canonicalUrl="https://clarity.oxy.so/my-page"
      />
      {/* content */}
    </>
  );
}
```

**Pages to update**:
- [done] `/` (Home) - META_PRESETS.home
- [done] `/login` - META_PRESETS.login
- [done] `/register` - META_PRESETS.register
- `/developers` - META_PRESETS.developers
- `/developers/documentation` - META_PRESETS.developers
- `/roles` - Create custom preset
- `/library` - Create custom preset

### 3. Create Additional Comparison Pages

**High priority for SEO**:

```bash
# Create these pages:
apps/app/app/vs/claude.tsx
apps/app/app/vs/gemini.tsx
apps/app/app/vs/copilot.tsx
```

Use `/vs/chatgpt.tsx` as a template.

### 4. Implement Blog with SEO Articles

**Recommended structure**:

```
apps/app/app/blog/
├── index.tsx                   (Article listing)
├── [slug].tsx                  (Individual article)
└── _posts/
    ├── best-ai-chat-2026.md
    ├── chatgpt-alternatives.md
    ├── ai-for-coding.md
    ├── alia-tutorial-beginners.md
    └── ...
```

**Recommended posts (long-tail keywords)**:
1. "Best AI Chat Tools in 2026" (keyword: best ai chat)
2. "Top ChatGPT Alternatives" (keyword: chatgpt alternatives)
3. "How to Use AI for Coding" (keyword: ai for coding)
4. "AI Chatbots with Memory: Complete Guide" (keyword: ai with memory)
5. "Clarity Tutorial for Beginners" (keyword: clarity tutorial)

### 5. Dynamic OG Images

**Implement Open Graph image generator**:

Options:
- **Vercel OG**: `@vercel/og` (only if using Vercel)
- **Serverless with Playwright**: Generates images on-demand
- **Pre-generated**: For static pages

**Structure**:

```typescript
// apps/app/app/api/og/route.ts
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title');

  // Generate image with dynamic title
  return new ImageResponse(...);
}
```

**Update meta-tags.ts**:

```typescript
export function generateOGImageURL(params: {
  title: string;
  subtitle?: string;
}) {
  return `https://clarity.oxy.so/api/og?title=${encodeURIComponent(params.title)}`;
}
```

---

## PHASE 3: MULTILINGUAL SEO (Advanced i18n)

Your app already has i18n with `i18n-js`. Now you need multilingual SEO.

### Implement Hreflang Tags

**The system is already prepared in `meta-tags.ts`**. You just need to use it:

```tsx
// Example in /ai-chat
<SEOHead
  {...META_PRESETS.aiChat}
  locale="en-US"
  alternateLocales={[
    { locale: 'es-ES', url: 'https://clarity.oxy.so/es/ai-chat' },
    { locale: 'fr-FR', url: 'https://clarity.oxy.so/fr/ai-chat' },
    { locale: 'de-DE', url: 'https://clarity.oxy.so/de/ai-chat' },
  ]}
/>
```

### Multilingual URL Strategy

**Option A: Subdirectories** (Recommended)
```
https://clarity.oxy.so/          (English, default)
https://clarity.oxy.so/es/       (Spanish)
https://clarity.oxy.so/fr/       (French)
https://clarity.oxy.so/de/       (German)
```

**Option B: Subdomains**
```
https://clarity.oxy.so/          (English)
https://es.clarity.oxy.so/       (Spanish)
https://fr.clarity.oxy.so/       (French)
```

**Implementation with Expo Router**:

Create structure:
```
apps/app/app/[locale]/
├── _layout.tsx
├── index.tsx
├── ai-chat.tsx
├── features.tsx
└── ...
```

---

## PHASE 4: CORE WEB VITALS & PERFORMANCE

### Critical Optimizations

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

// Use Expo Image with optimizations
<Image
  source={{ uri: 'https://...' }}
  contentFit="cover"
  transition={200}
  placeholder={blurhash}
/>
```

3. **Font Preloading**

Already in `+html.tsx`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="dns-prefetch" href="https://fonts.gstatic.com" />
```

4. **Reduce JavaScript Bundle**

```bash
# Analyze bundle
npx expo export --platform web --clear
npx source-map-explorer 'dist/**/*.js'
```

5. **Lazy Routes** (Expo Router feature)

```tsx
// app/_layout.tsx
export const unstable_settings = {
  initialRouteName: '(app)',
  // Expo Router already does automatic lazy loading of routes
};
```

---

## PHASE 5: MONITORING AND ANALYTICS

### Google Search Console

1. Verify ownership at: https://search.google.com/search-console
2. Submit sitemap: `https://clarity.oxy.so/sitemap.xml`
3. Monitor:
   - Impressions and clicks
   - CTR by query
   - Top-ranked pages
   - Indexing errors

### Google Analytics 4

**Add to `+html.tsx`**:

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

## LONG-TAIL CONTENT STRATEGY

### Blog Post Ideas (High SEO Impact)

1. **"10 Best ChatGPT Alternatives in 2026"**
   - Target: "chatgpt alternatives" (90K vol)
   - Include Clarity in position #1 or #2
   - Honest comparison with pros/cons

2. **"AI Chat for Developers: Complete Guide"**
   - Target: "ai for developers", "coding ai" (18K vol)
   - Showcase Clarity's API
   - Code examples

3. **"Free AI Chat Tools: Which One is Best?"**
   - Target: "free ai chat" (165K vol)
   - Compare free plans
   - CTA to Clarity registration

4. **"How to Use AI Chatbots Effectively"**
   - Target: "how to use ai chatbot" (35K vol)
   - Practical tutorial
   - Examples with Clarity

5. **"ChatGPT vs Claude vs Gemini vs Clarity"**
   - Target: "chatgpt vs claude vs gemini" (85K vol)
   - Mega comparison
   - Detailed comparison table

---

## QUICK WINS (Implement Now)

### 1. Update package.json

```json
{
  "scripts": {
    "generate-sitemap": "tsx apps/app/scripts/generate-sitemap.ts",
    "build:web": "npm run generate-sitemap && npm run build",
    "prebuild": "npm run generate-sitemap"
  }
}
```

### 2. Create Default OG Image

Design and add:
- `apps/app/public/og-image-default.png` (1200x630px)
- Clarity branding
- Tagline: "Chat with AI that remembers"

### 3. Add Breadcrumbs UI

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

### 4. Update +html.tsx with Canonical

```tsx
// apps/app/app/+html.tsx
<link rel="canonical" href="https://clarity.oxy.so/" />
```

---

## SUCCESS METRICS

### KPIs to Monitor (Monthly)

| Metric | Month 1 Goal | Month 3 Goal | Month 6 Goal |
|--------|--------------|--------------|--------------|
| Organic traffic | 1K visits | 10K visits | 50K+ visits |
| Keywords ranked (Top 10) | 5 keywords | 20 keywords | 50+ keywords |
| Backlinks | 10 | 50 | 200+ |
| Domain Authority | 15 | 25 | 35+ |
| Organic conversion | 2% | 3% | 5%+ |

### Tracking Tools

- **Google Search Console**: Rankings and CTR
- **Google Analytics 4**: Traffic and conversions
- **Ahrefs / Semrush**: Keywords and competition
- **PageSpeed Insights**: Core Web Vitals
- **Hotjar**: Behavior analytics (optional)

---

## LINK BUILDING STRATEGY

### High-Impact Tactics

1. **Product Hunt Launch**
   - Launch on Product Hunt
   - Goal: Backlink + initial traffic
   - Prepare demo video

2. **Developer Communities**
   - Post on Dev.to, Hashnode, Medium
   - Tutorial: "Build with Clarity API"
   - High-quality backlinks

3. **AI Tools Directories**
   - Submit to directories:
     - There's An AI For That
     - Future Tools
     - AI Tool Guru
     - Futurepedia

4. **Guest Posting**
   - Write for AI/Tech blogs
   - Topic: "Future of conversational AI"
   - Backlink to clarity.oxy.so

5. **Open Source**
   - Release SDKs on GitHub
   - NPM packages
   - Well-linked documentation

---

## MISTAKES TO AVOID

### Do NOT:

1. **Keyword Stuffing**: Keep titles clean (see update)
2. **Duplicate Content**: Each page must be unique
3. **Thin Content**: Minimum 300 words per page
4. **Missing Alt Text**: All images must have alt text
5. **Slow Loading**: Core Web Vitals are critical
6. **Mobile Issues**: Always mobile-first
7. **Broken Links**: Check regularly
8. **No SSL**: HTTPS is mandatory
9. **Ignored Search Console**: Review weekly
10. **Black Hat SEO**: Never buy links

---

## EXECUTIVE SUMMARY

### Completed (Phase 1)

- Dynamic sitemap
- Optimized robots.txt
- Meta tag system
- Reusable SEO components
- Schema.org structured data
- Landing pages: /ai-chat, /features, /pricing
- Comparison page: /vs/chatgpt

### Up Next (High Priority)

1. Update home page with SEO
2. Create /vs/claude and /vs/gemini
3. Implement blog with 5 articles
4. Generate dynamic OG images
5. Code splitting and performance
6. Google Search Console setup

### Roadmap (3 Months)

**Month 1**: Technical foundations + initial content
**Month 2**: Active blog + link building + i18n
**Month 3**: Continuous optimization + content expansion

---

## ADDITIONAL RESOURCES

- [Google Search Central](https://developers.google.com/search)
- [Schema.org](https://schema.org/)
- [Web.dev](https://web.dev/) - Core Web Vitals
- [Ahrefs Academy](https://ahrefs.com/academy) - SEO training
- [Expo SEO Guide](https://docs.expo.dev/guides/seo/)

---

**Last updated**: 2026-02-13
**Next review**: 2026-03-13
