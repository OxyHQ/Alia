/**
 * Componente SEOHead reutilizable para Expo Router
 * Uso: <SEOHead {...META_PRESETS.home} />
 */

import { Head } from 'expo-router';
import { generateMetaTags, type MetaTagsConfig } from '@/lib/seo/meta-tags';

interface SEOHeadProps extends MetaTagsConfig {
  children?: React.ReactNode;
}

export function SEOHead(props: SEOHeadProps) {
  const { children, ...config } = props;
  const metaTags = generateMetaTags(config);

  return (
    <Head>
      {/* Title */}
      <title>{metaTags.title}</title>

      {/* Basic Meta Tags */}
      <meta name="description" content={metaTags.description} />
      {metaTags.keywords && <meta name="keywords" content={metaTags.keywords} />}
      <meta name="author" content={metaTags.author} />
      <meta name="robots" content={metaTags.robots} />
      <meta name="googlebot" content={metaTags.googlebot} />

      {/* Canonical */}
      <link rel="canonical" href={metaTags.canonical} />

      {/* Open Graph */}
      <meta property="og:site_name" content={metaTags['og:site_name']} />
      <meta property="og:title" content={metaTags['og:title']} />
      <meta property="og:description" content={metaTags['og:description']} />
      <meta property="og:type" content={metaTags['og:type']} />
      <meta property="og:url" content={metaTags['og:url']} />
      <meta property="og:image" content={metaTags['og:image']} />
      <meta property="og:image:width" content={metaTags['og:image:width']} />
      <meta property="og:image:height" content={metaTags['og:image:height']} />
      <meta property="og:image:alt" content={metaTags['og:image:alt']} />
      <meta property="og:locale" content={metaTags['og:locale']} />

      {/* Twitter Card */}
      <meta name="twitter:card" content={metaTags['twitter:card']} />
      <meta name="twitter:site" content={metaTags['twitter:site']} />
      <meta name="twitter:creator" content={metaTags['twitter:creator']} />
      <meta name="twitter:title" content={metaTags['twitter:title']} />
      <meta name="twitter:description" content={metaTags['twitter:description']} />
      <meta name="twitter:image" content={metaTags['twitter:image']} />
      <meta name="twitter:image:alt" content={metaTags['twitter:image:alt']} />

      {/* Hreflang Tags */}
      {Object.keys(metaTags)
        .filter(key => key.startsWith('hreflang:'))
        .map(key => {
          const locale = key.replace('hreflang:', '');
          return <link key={key} rel="alternate" hrefLang={locale} href={metaTags[key]} />;
        })}

      {/* Article Meta Tags (if applicable) */}
      {metaTags['article:published_time'] && (
        <meta property="article:published_time" content={metaTags['article:published_time']} />
      )}
      {metaTags['article:modified_time'] && (
        <meta property="article:modified_time" content={metaTags['article:modified_time']} />
      )}
      {metaTags['article:author'] && (
        <meta property="article:author" content={metaTags['article:author']} />
      )}
      {metaTags['article:section'] && (
        <meta property="article:section" content={metaTags['article:section']} />
      )}

      {/* Mobile Meta Tags */}
      <meta name="viewport" content={metaTags.viewport} />
      <meta name="theme-color" content={metaTags['theme-color']} />
      <meta name="apple-mobile-web-app-capable" content={metaTags['apple-mobile-web-app-capable']} />
      <meta
        name="apple-mobile-web-app-status-bar-style"
        content={metaTags['apple-mobile-web-app-status-bar-style']}
      />
      <meta name="format-detection" content={metaTags['format-detection']} />

      {/* Custom children (for JSON-LD, etc.) */}
      {children}
    </Head>
  );
}
