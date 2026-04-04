/**
 * Sistema de Meta Tags Dinámicos para SEO en Expo Router
 * Uso: import { generateMetaTags } from '@/lib/seo/meta-tags'
 */

export interface MetaTagsConfig {
  title: string;
  description: string;
  keywords?: string[];
  canonicalUrl?: string;
  ogImage?: string;
  ogType?: 'website' | 'article' | 'product' | 'profile';
  article?: {
    publishedTime?: string;
    modifiedTime?: string;
    author?: string;
    section?: string;
    tags?: string[];
  };
  twitter?: {
    card?: 'summary' | 'summary_large_image' | 'app' | 'player';
    site?: string;
    creator?: string;
  };
  noindex?: boolean;
  locale?: string; // ISO locale codes (en-US, es-ES, fr-FR, etc.)
  alternateLocales?: Array<{ locale: string; url: string }>; // Para hreflang tags
}

const SITE_URL = 'https://clarity.oxy.so';
const SITE_NAME = 'Clarity by Oxy';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image-default.png`;
const TWITTER_HANDLE = '@ClarityByOxy'; // Actualizar con tu handle real

/**
 * Genera meta tags completos para SEO
 */
export function generateMetaTags(config: MetaTagsConfig): Record<string, string> {
  const {
    title,
    description,
    keywords = [],
    canonicalUrl,
    ogImage = DEFAULT_OG_IMAGE,
    ogType = 'website',
    article,
    twitter = {},
    noindex = false,
    locale = 'en-US',
    alternateLocales = [],
  } = config;

  // Título optimizado (max 60 caracteres)
  const fullTitle = title.includes('|') ? title : `${title} | ${SITE_NAME}`;

  // Descripción optimizada (155-160 caracteres)
  const metaDescription = description.substring(0, 160);

  // Canonical URL
  const canonical = canonicalUrl || SITE_URL;

  // Meta tags base
  const metaTags: Record<string, string> = {
    // Basic HTML Meta
    'title': fullTitle,
    'description': metaDescription,
    'keywords': keywords.join(', '),
    'author': 'Oxy Team',
    'robots': noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1',
    'googlebot': noindex ? 'noindex, nofollow' : 'index, follow',

    // Canonical
    'canonical': canonical,

    // Open Graph (Facebook, LinkedIn, WhatsApp)
    'og:site_name': SITE_NAME,
    'og:title': fullTitle,
    'og:description': metaDescription,
    'og:type': ogType,
    'og:url': canonical,
    'og:image': ogImage,
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': title,
    'og:locale': locale.replace('-', '_'),

    // Twitter Card
    'twitter:card': twitter.card || 'summary_large_image',
    'twitter:site': twitter.site || TWITTER_HANDLE,
    'twitter:creator': twitter.creator || TWITTER_HANDLE,
    'twitter:title': fullTitle,
    'twitter:description': metaDescription,
    'twitter:image': ogImage,
    'twitter:image:alt': title,

    // Mobile
    'viewport': 'width=device-width, initial-scale=1, maximum-scale=5',
    'theme-color': '#ca52e9',
    'format-detection': 'telephone=no',
  };

  // Hreflang tags for multilingual SEO
  alternateLocales.forEach((alt, index) => {
    metaTags[`hreflang:${alt.locale}`] = alt.url;
  });
  // Self-referencing hreflang
  metaTags[`hreflang:${locale}`] = canonical;
  metaTags['hreflang:x-default'] = canonical;

  // Article-specific meta tags
  if (ogType === 'article' && article) {
    if (article.publishedTime) {
      metaTags['article:published_time'] = article.publishedTime;
    }
    if (article.modifiedTime) {
      metaTags['article:modified_time'] = article.modifiedTime;
    }
    if (article.author) {
      metaTags['article:author'] = article.author;
    }
    if (article.section) {
      metaTags['article:section'] = article.section;
    }
    if (article.tags) {
      article.tags.forEach((tag, index) => {
        metaTags[`article:tag:${index}`] = tag;
      });
    }
  }

  return metaTags;
}

/**
 * Predefined meta tags para páginas comunes
 */
export const META_PRESETS = {
  home: {
    title: 'Clarity | Oxy',
    description: 'Clarity is an AI-powered search engine by Oxy. Get comprehensive answers with cited sources.',
    keywords: ['ai chat', 'chatbot', 'artificial intelligence', 'ai assistant', 'conversational ai'],
    canonicalUrl: SITE_URL,
  },

  aiChat: {
    title: 'Search with AI - Clarity',
    description: 'Search smarter with Clarity. AI-powered search engine that provides comprehensive answers with cited sources.',
    keywords: ['ai chat', 'chat with ai', 'conversational ai', 'intelligent chatbot'],
    canonicalUrl: `${SITE_URL}/ai-chat`,
  },

  chatbotAI: {
    title: 'AI Search - Clarity',
    description: 'Your personal AI assistant for work and creativity. Answer questions, generate content, write code, and more.',
    keywords: ['chatbot ai', 'ai assistant', 'virtual assistant', 'intelligent chatbot'],
    canonicalUrl: `${SITE_URL}/chatbot-ai`,
  },

  features: {
    title: 'Features - Clarity',
    description: 'Discover Clarity features: deep research, source citations, follow-up suggestions, and a powerful developer API.',
    keywords: ['ai features', 'contextual memory', 'ai models', 'chatbot api'],
    canonicalUrl: `${SITE_URL}/features`,
  },

  vsChatGPT: {
    title: 'Clarity vs ChatGPT',
    description: 'An honest comparison between Clarity and ChatGPT. Explore the differences in features, pricing, and capabilities.',
    keywords: ['clarity vs chatgpt', 'chatgpt comparison', 'ai assistant comparison'],
    canonicalUrl: `${SITE_URL}/vs/chatgpt`,
    ogType: 'article' as const,
  },

  vsClaude: {
    title: 'Clarity vs Claude',
    description: 'Compare Clarity and Claude side by side. Features, performance, and use cases explained.',
    keywords: ['clarity vs claude', 'claude comparison', 'ai comparison'],
    canonicalUrl: `${SITE_URL}/vs/claude`,
    ogType: 'article' as const,
  },

  vsGemini: {
    title: 'Clarity vs Gemini',
    description: 'How does Clarity compare to Google Gemini? A detailed look at strengths and differences.',
    keywords: ['clarity vs gemini', 'gemini comparison', 'google ai'],
    canonicalUrl: `${SITE_URL}/vs/gemini`,
    ogType: 'article' as const,
  },

  developers: {
    title: 'API Documentation - Clarity',
    description: 'Build with Clarity. Industry-standard API, comprehensive docs, and code examples to integrate AI into your applications.',
    keywords: ['chatbot api', 'ai api', 'openai compatible', 'developer api'],
    canonicalUrl: `${SITE_URL}/developers/documentation`,
  },

  pricing: {
    title: 'Pricing - Clarity',
    description: 'Simple, transparent pricing. Start free, pay as you grow. No subscriptions, just credits that never expire.',
    keywords: ['ai pricing', 'chatbot pricing', 'pay as you go'],
    canonicalUrl: `${SITE_URL}/pricing`,
  },

  blog: {
    title: 'Blog - Clarity',
    description: 'Insights, tutorials, and updates from the Clarity team. Learn how to get the most out of AI.',
    keywords: ['ai blog', 'ai tutorials', 'ai news', 'ai guides'],
    canonicalUrl: `${SITE_URL}/blog`,
  },

  useCases: {
    title: 'Use Cases - Clarity',
    description: 'See how people use Clarity for coding, writing, research, learning, and creative work.',
    keywords: ['ai use cases', 'ai examples', 'ai productivity', 'ai applications'],
    canonicalUrl: `${SITE_URL}/use-cases`,
  },

  login: {
    title: 'Login',
    description: 'Sign in to Clarity',
    noindex: true,
  },

  register: {
    title: 'Sign Up',
    description: 'Create your free Clarity account. No credit card required.',
    keywords: ['sign up', 'create account', 'free ai'],
    canonicalUrl: `${SITE_URL}/register`,
  },
};

/**
 * Helper para generar OG image URL dinámica
 */
export function generateOGImageURL(params: {
  title: string;
  subtitle?: string;
  template?: 'default' | 'article' | 'comparison';
}): string {
  const { title, subtitle, template = 'default' } = params;

  // Si implementas servicio de OG images dinámicas (ej: usando Vercel OG)
  const baseUrl = `${SITE_URL}/api/og`;
  const searchParams = new URLSearchParams({
    title,
    ...(subtitle && { subtitle }),
    template,
  });

  return `${baseUrl}?${searchParams.toString()}`;
}

/**
 * Helper para generar breadcrumb schema
 */
export function generateBreadcrumbSchema(items: Array<{ name: string; url: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    'itemListElement': items.map((item, index) => ({
      '@type': 'ListItem',
      'position': index + 1,
      'name': item.name,
      'item': item.url,
    })),
  };
}
