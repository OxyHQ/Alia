/**
 * Auto-generated sitemap.xml for Clarity
 * Ejecutar: npm run generate-sitemap
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = 'https://clarity.oxy.so';
const CURRENT_DATE = new Date().toISOString().split('T')[0];

interface SitemapURL {
  loc: string;
  lastmod: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

// Rutas estáticas existentes
const staticRoutes: SitemapURL[] = [
  {
    loc: '/',
    lastmod: CURRENT_DATE,
    changefreq: 'daily',
    priority: 1.0,
  },
  {
    loc: '/register',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.8,
  },
  {
    loc: '/library',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.7,
  },
  {
    loc: '/roles',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.7,
  },
  {
    loc: '/developers',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.8,
  },
  {
    loc: '/developers/documentation',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.9,
  },
  {
    loc: '/developers/examples',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.8,
  },
];

function generateSitemapXML(urls: SitemapURL[]): string {
  const urlEntries = urls
    .map(
      ({ loc, lastmod, changefreq, priority }) => `
  <url>
    <loc>${SITE_URL}${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}
</urlset>`;
}

async function generateSitemap() {
  console.log('🗺️  Generating sitemap.xml for Clarity...');

  const sitemapXML = generateSitemapXML(staticRoutes);

  // Save to /public
  const publicPath = path.resolve(__dirname, '../public/sitemap.xml');
  fs.writeFileSync(publicPath, sitemapXML, 'utf-8');
  console.log(`✅ Sitemap generated: ${publicPath}`);

  // Also save to /dist if it exists
  const distPath = path.resolve(__dirname, '../dist/sitemap.xml');
  const distDir = path.dirname(distPath);
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(distPath, sitemapXML, 'utf-8');
    console.log(`✅ Sitemap copied to: ${distPath}`);
  }

  console.log(`\n📊 Total URLs in sitemap: ${staticRoutes.length}`);
  console.log('🎉 Sitemap generated successfully!');
}

// Execute
generateSitemap().catch(console.error);
