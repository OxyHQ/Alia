import { tool } from "ai";
import { z } from "zod";

/**
 * Web Reader tool for AI SDK
 * Fetches content from a URL and returns it as text
 */
export const scrapeURLTool = tool({
  description: "Lee el contenido de una URL específica para obtener información detallada o resumir artículos.",
  inputSchema: z.object({
    url: z.string().url().describe("La URL del sitio web o artículo a leer"),
  }),
  execute: async ({ url }) => {
    try {
      console.log("[Web Reader Tool] Fetching URL:", url);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        // @ts-expect-error next.js-specific cache option
        next: { revalidate: 3600 }
      });

      if (!response.ok) {
        throw new Error(`Error al acceder a la URL: ${response.statusText}`);
      }

      const html = await response.text();
      
      // Simple extraction of text from HTML (removing tags)
      // For a more robust solution, use JSDOM or a library like 'cheerio' or 'html-to-text'
      const cleanText = html
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
        .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000); // Limit to 10k characters for context safety

      return {
        url,
        content: cleanText,
        length: cleanText.length
      };
    } catch (error) {
      console.error("[Web Reader Tool] Error:", error);
      return {
        url,
        error: error instanceof Error ? error.message : "Error desconocido al leer la URL"
      };
    }
  },
});
