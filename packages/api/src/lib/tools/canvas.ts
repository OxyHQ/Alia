import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export const canvasTool = tool({
  description: 'Create a visual canvas component (chart, table, code block, form, image, or markdown) to display rich content to the user',
  inputSchema: z.object({
    type: z.enum(['chart', 'table', 'code', 'form', 'image', 'markdown', 'artifact']).describe('The type of canvas component to create'),
    title: z.string().describe('Title for the canvas component'),
    data: z.any().describe('Component data. For chart: { chartType, labels, datasets }. For table: { headers, rows }. For code: { language, code }. For form: { fields }. For image: { url, alt? }. For markdown: { content }. For artifact: { content, language? }'),
  }),
  execute: async ({ type, title, data }) => {
    return {
      id: randomUUID(),
      type,
      title,
      data,
      message: 'Canvas component created',
    };
  },
});
