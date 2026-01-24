/**
 * Componente SEOHead reutilizable para Expo Router
 * Uso: <SEOHead {...META_PRESETS.home} />
 */

import { Head } from 'expo-router';
import type { MetaTagsConfig } from '@/lib/seo/meta-tags';

interface SEOHeadProps extends MetaTagsConfig {
  children?: React.ReactNode;
}

export function SEOHead(props: SEOHeadProps) {
  const {
    title,
    description,
    keywords = [],
    canonicalUrl,
    ogImage = 'https://alia.onl/og-image-default.png',
    ogType = 'website',
    noindex = false,
    children,
  } = props;

  const SITE_NAME = 'Alia by Oxy';
  const SITE_URL = 'https://alia.onl';
  const fullTitle = title.includes('|') ? title : `${title} | ${SITE_NAME}`;
  const canonical = canonicalUrl || SITE_URL;

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {keywords.length > 0 && <meta name="keywords" content={keywords.join(', ')} />}
      <meta name="author" content="Oxy Team" />
      <meta name="robots" content={noindex ? 'noindex, nofollow' : 'index, follow'} />
      <link rel="canonical" href={canonical} />

      {/* Open Graph */}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={ogType} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {/* Custom children (for JSON-LD, etc.) */}
      {children}
    </Head>
  );
}
