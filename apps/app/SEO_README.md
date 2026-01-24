# 🚀 SEO Implementation - Alia

## ✅ IMPLEMENTED

Basic SEO is now working without React errors:

### What's Done
- ✅ **Sitemap generator** - Auto-generates sitemap.xml
- ✅ **Robots.txt** - Optimized for SEO
- ✅ **Home page SEO** - Title, description, OG tags
- ✅ **Login/Register** - Basic meta tags
- ✅ **package.json** - Configured with sitemap script

### How It Works
- Using `Head` from `expo-router/head` directly
- Simple, clean meta tags
- No complex components (avoids React hydration issues)

---

## 🎯 NEXT STEPS

### 1. Install Dependencies
```bash
npm install
```

### 2. Generate Sitemap
```bash
npm run generate-sitemap
```

### 3. Create OG Image (Optional)
Create `public/og-image-default.png` (1200x630px)

### 4. After Deploy
- Configure Google Search Console
- Submit sitemap: https://alia.onl/sitemap.xml

---

## 📄 Creating New SEO Pages

When creating new pages, add SEO like this:

```tsx
import Head from 'expo-router/head';

export default function MyPage() {
  return (
    <>
      <Head>
        <title>Page Title</title>
        <meta name="description" content="Page description (155-160 chars)" />
        <link rel="canonical" href="https://alia.onl/my-page" />
        <meta property="og:title" content="Page Title" />
        <meta property="og:description" content="Page description" />
        <meta property="og:image" content="https://alia.onl/og-image-default.png" />
      </Head>

      {/* Your page content */}
    </>
  );
}
```

---

## 🗂️ Available SEO Helpers

You have helper files for advanced SEO (when you need them):

- `lib/seo/meta-tags.ts` - Meta tag presets and helpers
- `lib/seo/structured-data.ts` - Schema.org JSON-LD helpers

Use them directly in your `<Head>` tags when needed.

---

## 📊 Expected Results

**Month 1-3**: 5K-10K organic visits, 20+ keywords ranked
**Month 6+**: 50K+ organic visits, 100+ keywords

---

For full strategy, see `SEO_STRATEGY.md`
