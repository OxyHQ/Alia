import { tool } from 'ai';
import { z } from 'zod';

export const generateFileTool = tool({
  description: 'Generate a file (CSV, JSON, Markdown, or plain text) with the given content. Returns the content formatted as a downloadable code block.',
  inputSchema: z.object({
    filename: z.string().describe('Name of the file to generate (e.g., "report.csv", "data.json")'),
    content: z.string().describe('The content of the file'),
    format: z.enum(['csv', 'json', 'markdown', 'text']).describe('The file format'),
  }),
  execute: async ({ filename, content, format }) => {
    return {
      filename,
      format,
      content,
      message: `Generated ${filename} (${format} format, ${content.length} characters)`,
    };
  },
});
