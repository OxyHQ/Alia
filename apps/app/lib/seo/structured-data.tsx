/**
 * Schema.org Structured Data para SEO
 * Genera JSON-LD para rich snippets en Google
 */

import React from 'react';

const SITE_URL = 'https://alia.onl';
const SITE_NAME = 'Alia by Oxy';
const LOGO_URL = `${SITE_URL}/icon-512.png`;

/**
 * Schema.org Organization
 */
export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    'name': SITE_NAME,
    'legalName': 'Oxy Technologies Inc.',
    'url': SITE_URL,
    'logo': LOGO_URL,
    'foundingDate': '2024',
    'description': 'Advanced AI chat assistant with contextual memory and multilingual support. Free ChatGPT alternative.',
    'sameAs': [
      'https://twitter.com/AliaByOxy',
      'https://github.com/oxy',
      'https://linkedin.com/company/oxy',
    ],
    'contactPoint': {
      '@type': 'ContactPoint',
      'contactType': 'Customer Support',
      'email': 'support@alia.onl',
      'availableLanguage': ['en', 'es', 'fr', 'de', 'pt', 'it', 'ja', 'zh', 'ko'],
    },
  };
}

/**
 * Schema.org WebApplication
 */
export function generateWebApplicationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    'name': SITE_NAME,
    'url': SITE_URL,
    'description': 'Alia is an advanced AI chat assistant with contextual memory, multiple AI models, and multilingual support. Free alternative to ChatGPT.',
    'applicationCategory': 'UtilityApplication',
    'operatingSystem': 'Web, iOS, Android',
    'offers': {
      '@type': 'Offer',
      'price': '0',
      'priceCurrency': 'USD',
      'availability': 'https://schema.org/InStock',
    },
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': '4.8',
      'ratingCount': '1247',
      'bestRating': '5',
      'worstRating': '1',
    },
    'author': {
      '@type': 'Organization',
      'name': 'Oxy Technologies',
    },
    'screenshot': `${SITE_URL}/screenshots/chat-interface.png`,
    'featureList': [
      'Advanced AI chat with memory',
      'Multiple AI models (GPT-4, Claude, Gemini)',
      'Custom roles and personas',
      'Developer API',
      'Multilingual support (50+ languages)',
      'Free tier available',
    ],
  };
}

/**
 * Schema.org SoftwareApplication (más específico para apps)
 */
export function generateSoftwareApplicationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    'name': SITE_NAME,
    'applicationCategory': 'BusinessApplication',
    'operatingSystem': 'Web Browser, iOS, Android',
    'offers': [
      {
        '@type': 'Offer',
        'name': 'Free Plan',
        'price': '0',
        'priceCurrency': 'USD',
      },
      {
        '@type': 'Offer',
        'name': 'Pro Plan',
        'price': '20',
        'priceCurrency': 'USD',
        'priceSpecification': {
          '@type': 'UnitPriceSpecification',
          'billingDuration': 'P1M',
          'billingIncrement': '1',
        },
      },
    ],
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': '4.8',
      'ratingCount': '1247',
    },
  };
}

/**
 * Schema.org FAQ (para páginas de features, pricing, etc.)
 */
export function generateFAQSchema(faqs: Array<{ question: string; answer: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': faqs.map(faq => ({
      '@type': 'Question',
      'name': faq.question,
      'acceptedAnswer': {
        '@type': 'Answer',
        'text': faq.answer,
      },
    })),
  };
}

/**
 * Schema.org Article (para blog posts)
 */
export function generateArticleSchema(article: {
  title: string;
  description: string;
  author: string;
  datePublished: string;
  dateModified?: string;
  image?: string;
  url: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    'headline': article.title,
    'description': article.description,
    'image': article.image || `${SITE_URL}/og-image-default.png`,
    'datePublished': article.datePublished,
    'dateModified': article.dateModified || article.datePublished,
    'author': {
      '@type': 'Person',
      'name': article.author,
    },
    'publisher': {
      '@type': 'Organization',
      'name': SITE_NAME,
      'logo': {
        '@type': 'ImageObject',
        'url': LOGO_URL,
      },
    },
    'url': article.url,
  };
}

/**
 * Schema.org BreadcrumbList
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

/**
 * Schema.org HowTo (para tutoriales)
 */
export function generateHowToSchema(howto: {
  name: string;
  description: string;
  steps: Array<{ name: string; text: string; image?: string }>;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    'name': howto.name,
    'description': howto.description,
    'step': howto.steps.map((step, index) => ({
      '@type': 'HowToStep',
      'position': index + 1,
      'name': step.name,
      'text': step.text,
      ...(step.image && { image: step.image }),
    })),
  };
}

/**
 * Schema.org Product (para comparaciones vs ChatGPT, Claude, etc.)
 */
export function generateProductSchema(product: {
  name: string;
  description: string;
  image?: string;
  offers?: {
    price: string;
    priceCurrency: string;
  };
  rating?: {
    value: number;
    count: number;
  };
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    'name': product.name,
    'description': product.description,
    'image': product.image || `${SITE_URL}/og-image-default.png`,
    ...(product.offers && {
      offers: {
        '@type': 'Offer',
        'price': product.offers.price,
        'priceCurrency': product.offers.priceCurrency,
        'availability': 'https://schema.org/InStock',
      },
    }),
    ...(product.rating && {
      aggregateRating: {
        '@type': 'AggregateRating',
        'ratingValue': product.rating.value.toString(),
        'ratingCount': product.rating.count.toString(),
      },
    }),
  };
}

/**
 * Schema.org VideoObject (si tienes demos en video)
 */
export function generateVideoSchema(video: {
  name: string;
  description: string;
  thumbnailUrl: string;
  uploadDate: string;
  contentUrl: string;
  duration?: string; // ISO 8601 format (PT1M30S = 1 min 30 sec)
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    'name': video.name,
    'description': video.description,
    'thumbnailUrl': video.thumbnailUrl,
    'uploadDate': video.uploadDate,
    'contentUrl': video.contentUrl,
    ...(video.duration && { duration: video.duration }),
  };
}

/**
 * Helper para insertar JSON-LD en Head
 */
export function JSONLDScript({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data),
      }}
    />
  );
}

/**
 * Presets comunes de structured data
 */
export const STRUCTURED_DATA_PRESETS = {
  homepage: [generateOrganizationSchema(), generateWebApplicationSchema()],

  features: [
    generateWebApplicationSchema(),
    generateFAQSchema([
      {
        question: 'What makes Alia different from ChatGPT?',
        answer:
          'Alia offers enhanced contextual memory, multiple AI models in one platform, custom roles, developer API access, and native multilingual support across 50+ languages.',
      },
      {
        question: 'Is Alia free to use?',
        answer:
          'Yes! Alia offers a generous free tier with access to advanced AI models. Pro plans are available for power users who need higher limits.',
      },
      {
        question: 'Which AI models does Alia support?',
        answer:
          'Alia supports multiple leading AI models including GPT-4, Claude 3, Google Gemini, and more. You can switch between models seamlessly.',
      },
      {
        question: 'Can I use Alia for coding?',
        answer:
          'Absolutely! Alia excels at coding assistance, debugging, code review, and technical explanations across all major programming languages.',
      },
    ]),
  ],

  pricing: [
    generateSoftwareApplicationSchema(),
    generateFAQSchema([
      {
        question: 'How does pricing work?',
        answer:
          'Alia uses a credit-based system. Free tier includes generous credits monthly. Pro users can purchase additional credits as needed with no subscription required.',
      },
      {
        question: 'Can I cancel anytime?',
        answer:
          'Yes! There are no contracts or subscriptions. Purchase credits when you need them, use them at your own pace.',
      },
      {
        question: 'Do unused credits expire?',
        answer: 'No. Your credits never expire and roll over month to month.',
      },
    ]),
  ],
};
