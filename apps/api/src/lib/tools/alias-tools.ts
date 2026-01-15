import { tool } from "ai";
import { z } from "zod";

/**
 * Timeline tool for AI SDK
 * Returns events in chronological order
 */
export const getTimelineTool = tool({
  description: "Obtener la cronología de eventos relevantes. Úsalo cuando pregunten por 'qué pasó', 'cuándo', 'cronología' o 'historia'.",
  inputSchema: z.object({
    query: z.string().optional().describe("Filtro opcional para la cronología"),
  }),
  execute: async ({ query }) => {
    // In a real app, this would query a database
    // For now, we return a sample or empty list
    return {
      events: [
        { date: "Enero 2024", title: "Lanzamiento de Alia AI", description: "Alia AI nace como asistente inteligente." },
        { date: "Marzo 2024", title: "Integración con Google Search", description: "Alia ahora puede buscar en tiempo real." },
        { date: "Hoy", title: "Funcionalidades de Gaila integradas", description: "Alia ahora soporta bloques visuales avanzados." }
      ].filter(e => !query || e.title.toLowerCase().includes(query.toLowerCase()) || e.description.toLowerCase().includes(query.toLowerCase())),
      count: 3
    };
  },
});

/**
 * Knowledge Base tool
 * Fallback search in internal knowledge
 */
export const searchKnowledgeBaseTool = tool({
  description: "Busca en la base de conocimientos interna de Alia.",
  inputSchema: z.object({
    query: z.string().describe("Consulta de búsqueda"),
  }),
  execute: async ({ query }) => {
    return {
      results: [
        { title: "Manual de Alia", snippet: "Alia es un asistente diseñado por el equipo de Deepmind...", url: "/docs/manual" }
      ],
      count: 1
    };
  },
});
