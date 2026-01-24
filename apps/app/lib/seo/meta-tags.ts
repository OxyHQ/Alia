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

const SITE_URL = 'https://alia.onl';
const SITE_NAME = 'Alia by Oxy';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image-default.png`;
const TWITTER_HANDLE = '@AliaByOxy'; // Actualizar con tu handle real

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
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
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
    title: 'Alia \ Oxy',
    description: 'Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly.',
    keywords: ['ai chat', 'chatbot', 'artificial intelligence', 'ai assistant', 'conversational ai'],
    canonicalUrl: SITE_URL,
  },

  aiChat: {
    title: 'Chat with AI - Alia',
    description: 'Have intelligent conversations with Alia. Advanced AI that understands context, remembers your preferences, and adapts to your needs.',
    keywords: ['ai chat', 'chat with ai', 'conversational ai', 'intelligent chatbot'],
    canonicalUrl: `${SITE_URL}/ai-chat`,
  },

  chatbotAI: {
    title: 'AI Assistant - Alia',
    description: 'Your personal AI assistant for work and creativity. Answer questions, generate content, write code, and more.',
    keywords: ['chatbot ai', 'ai assistant', 'virtual assistant', 'intelligent chatbot'],
    canonicalUrl: `${SITE_URL}/chatbot-ai`,
  },

  features: {
    title: 'Features - Alia',
    description: 'Discover what makes Alia different: persistent memory, multiple AI models, custom personas, and a powerful developer API.',
    keywords: ['ai features', 'contextual memory', 'ai models', 'chatbot api'],
    canonicalUrl: `${SITE_URL}/features`,
  },

  vsChatGPT: {
    title: 'Alia vs ChatGPT',
    description: 'An honest comparison between Alia and ChatGPT. Explore the differences in features, pricing, and capabilities.',
    keywords: ['alia vs chatgpt', 'chatgpt comparison', 'ai assistant comparison'],
    canonicalUrl: `${SITE_URL}/vs/chatgpt`,
    ogType: 'article' as const,
  },

  vsClaude: {
    title: 'Alia vs Claude',
    description: 'Compare Alia and Claude side by side. Features, performance, and use cases explained.',
    keywords: ['alia vs claude', 'claude comparison', 'ai comparison'],
    canonicalUrl: `${SITE_URL}/vs/claude`,
    ogType: 'article' as const,
  },

  vsGemini: {
    title: 'Alia vs Gemini',
    description: 'How does Alia compare to Google Gemini? A detailed look at strengths and differences.',
    keywords: ['alia vs gemini', 'gemini comparison', 'google ai'],
    canonicalUrl: `${SITE_URL}/vs/gemini`,
    ogType: 'article' as const,
  },

  developers: {
    title: 'API Documentation - Alia',
    description: 'Build with Alia. OpenAI-compatible API, comprehensive docs, and code examples to integrate AI into your applications.',
    keywords: ['chatbot api', 'ai api', 'openai compatible', 'developer api'],
    canonicalUrl: `${SITE_URL}/developers/documentation`,
  },

  pricing: {
    title: 'Pricing - Alia',
    description: 'Simple, transparent pricing. Start free, pay as you grow. No subscriptions, just credits that never expire.',
    keywords: ['ai pricing', 'chatbot pricing', 'pay as you go'],
    canonicalUrl: `${SITE_URL}/pricing`,
  },

  blog: {
    title: 'Blog - Alia',
    description: 'Insights, tutorials, and updates from the Alia team. Learn how to get the most out of AI.',
    keywords: ['ai blog', 'ai tutorials', 'ai news', 'ai guides'],
    canonicalUrl: `${SITE_URL}/blog`,
  },

  useCases: {
    title: 'Use Cases - Alia',
    description: 'See how people use Alia for coding, writing, research, learning, and creative work.',
    keywords: ['ai use cases', 'ai examples', 'ai productivity', 'ai applications'],
    canonicalUrl: `${SITE_URL}/use-cases`,
  },

  login: {
    title: 'Login',
    description: 'Sign in to Alia',
    noindex: true,
  },

  register: {
    title: 'Sign Up',
    description: 'Create your free Alia account. No credit card required.',
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
