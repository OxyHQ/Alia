import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * Root HTML component for static rendering
 * This file runs during static rendering in Node.js for SEO optimization
 * Don't wrap your app with Providers here - that should be in _layout.tsx
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />

        {/* Viewport and mobile optimization */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        {/* Primary Meta Tags */}
        <meta name="title" content="Alia" />
        <meta
          name="description"
          content="Alia helps you get answers, explore ideas, and boost productivity. An AI assistant for work, learning, and creative inspiration."
        />
        <meta
          name="keywords"
          content="AI chat, AI assistant, chatbot, artificial intelligence, productivity, AI conversation, machine learning, chat AI"
        />

        {/* Open Graph / Facebook Meta Tags for social sharing */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://alia.onl/" />
        <meta property="og:title" content="Alia" />
        <meta
          property="og:description"
          content="Alia helps you get answers, explore ideas, and boost productivity. An AI assistant for work, learning, and creative inspiration."
        />
        <meta property="og:image" content="/og-image.png" />

        {/* Twitter Card Meta Tags */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content="https://alia.onl/" />
        <meta property="twitter:title" content="Alia" />
        <meta
          property="twitter:description"
          content="Alia helps you get answers, explore ideas, and boost productivity. An AI assistant for work, learning, and creative inspiration."
        />
        <meta property="twitter:image" content="/og-image.png" />

        {/* Theme color for mobile browsers */}
        <meta name="theme-color" content="#ca52e9" />

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* Disable body scrolling for native-like feel on web */}
        <ScrollViewStyleReset />

        {/* Preconnect to important domains for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
