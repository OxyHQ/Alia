/**
 * Generador automático de sitemap.xml para Alia by Oxy
 * Ejecutar: npm run generate-sitemap
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = 'https://alia.onl';
const CURRENT_DATE = new Date().toISOString().split('T')[0];

interface SitemapURL {
  loc: string;
  lastmod: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

// Rutas estáticas con configuración SEO
const staticRoutes: SitemapURL[] = [
  {
    loc: '/',
    lastmod: CURRENT_DATE,
    changefreq: 'daily',
    priority: 1.0,
  },
  {
    loc: '/login',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.6,
  },
  {
    loc: '/register',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.8,
  },
  {
    loc: '/forgot-password',
    lastmod: CURRENT_DATE,
    changefreq: 'yearly',
    priority: 0.3,
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
    loc: '/billing',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.5,
  },
  {
    loc: '/settings',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.4,
  },
  {
    loc: '/settings/account',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.4,
  },
  {
    loc: '/settings/memory',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.4,
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
  // Nuevas landing pages SEO (crear después)
  {
    loc: '/ai-chat',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.95,
  },
  {
    loc: '/chatbot-ai',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.95,
  },
  {
    loc: '/ai-assistant',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.95,
  },
  {
    loc: '/features',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.9,
  },
  {
    loc: '/use-cases',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.85,
  },
  {
    loc: '/pricing',
    lastmod: CURRENT_DATE,
    changefreq: 'monthly',
    priority: 0.9,
  },
  {
    loc: '/vs/chatgpt',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.85,
  },
  {
    loc: '/vs/claude',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.85,
  },
  {
    loc: '/vs/gemini',
    lastmod: CURRENT_DATE,
    changefreq: 'weekly',
    priority: 0.85,
  },
  {
    loc: '/blog',
    lastmod: CURRENT_DATE,
    changefreq: 'daily',
    priority: 0.9,
  },
];

// Función para obtener rutas dinámicas desde API (ejemplo)
async function getDynamicRoutes(): Promise<SitemapURL[]> {
  // TODO: Integrar con tu API para obtener:
  // - IDs de conversaciones públicas
  // - Roles populares con /roles/[id]
  // - Posts del blog con /blog/[slug]
  //
  // Ejemplo:
  // const response = await fetch(`${SITE_URL}/api/public-content`);
  // const data = await response.json();

  const dynamicRoutes: SitemapURL[] = [];

  // Ejemplo: rutas de roles populares
  const popularRoleIds = ['coding-assistant', 'spanish-tutor', 'content-writer'];
  popularRoleIds.forEach(id => {
    dynamicRoutes.push({
      loc: `/roles/${id}`,
      lastmod: CURRENT_DATE,
      changefreq: 'weekly',
      priority: 0.75,
    });
  });

  return dynamicRoutes;
}

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
  console.log('🗺️  Generando sitemap.xml para Alia by Oxy...');

  // Combinar rutas estáticas y dinámicas
  const dynamicRoutes = await getDynamicRoutes();
  const allRoutes = [...staticRoutes, ...dynamicRoutes];

  // Generar XML
  const sitemapXML = generateSitemapXML(allRoutes);

  // Guardar en /public y /dist
  const publicPath = path.resolve(__dirname, '../public/sitemap.xml');
  const distPath = path.resolve(__dirname, '../dist/sitemap.xml');

  fs.writeFileSync(publicPath, sitemapXML, 'utf-8');
  console.log(`✅ Sitemap generado en: ${publicPath}`);

  // Crear directorio dist si no existe
  const distDir = path.dirname(distPath);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  fs.writeFileSync(distPath, sitemapXML, 'utf-8');
  console.log(`✅ Sitemap copiado a: ${distPath}`);

  console.log(`\n📊 Total de URLs en sitemap: ${allRoutes.length}`);
  console.log('🎉 Sitemap generado exitosamente!');
}

// Ejecutar
generateSitemap().catch(console.error);
