import { tool } from "ai";
import { z } from "zod";

/**
 * Current Date tool for AI SDK
 * Returns the current date and time in Spanish locale format
 */
export const getCurrentDateTool = tool({
  description: "Obtener la fecha y hora actual.",
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date();
    return { 
      date: now.toLocaleDateString("es-ES", { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      }),
      time: now.toLocaleTimeString("es-ES"),
      timestamp: now.toISOString()
    };
  },
});
