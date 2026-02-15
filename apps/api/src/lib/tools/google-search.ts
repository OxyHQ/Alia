import { tool } from "ai";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { log } from '../logger.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  count: number;
  error?: string;
}

/**
 * Google Search tool for AI SDK
 * Uses Google AI Studio Gemini with googleSearch grounding
 */
export const createGoogleSearchTool = (apiKey: string) => tool({
  description: "Busca información reciente y relevante en internet usando Google Search. Úsalo cuando necesites información actualizada o datos que no conoces.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("La consulta de búsqueda para buscar en internet"),
  }),
  execute: async ({ query }: { query: string }): Promise<WebSearchResponse> => {
    try {
      log.tools.info({ query }, 'Google Search executing');
      
      const google = createGoogleGenerativeAI({ apiKey });
      
      const result = await generateText({
        model: google("gemini-2.5-flash"),
        tools: {
          google_search: google.tools.googleSearch({}),
        },
        toolChoice: "required",
        prompt: `Busca información reciente y relevante sobre: ${query}. Debes usar la herramienta google_search para realizar la búsqueda.`,
      });

      log.tools.info({ sources: result.sources?.length || 0 }, 'Google Search result sources');
      
      const rawSources = result.sources as unknown as Array<{ title?: string; url: string; snippet?: string }> | undefined;
      
      if (!rawSources || rawSources.length === 0) {
        log.tools.info('Google Search returned no sources');
        return { count: 0, results: [] };
      }

      const results: WebSearchResult[] = rawSources.map((s) => ({
        title: s.title || "Sin título",
        url: s.url,
        snippet: s.snippet || ""
      }));

      log.tools.info({ count: results.length }, 'Google Search found results');
      return { results, count: results.length };
    } catch (error) {
      log.tools.error({ err: error }, 'Google Search error');
      const errorMessage = error instanceof Error ? error.message : "Fallo en búsqueda web";
      return { 
        error: errorMessage,
        results: [], 
        count: 0 
      };
    }
  },
});
