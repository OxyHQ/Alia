import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'crypto';

/**
 * The canvas: content drawn for the person rather than written in the reply.
 *
 * `deck` and `dashboard` are whole artifacts a surface opens on their own (Astro opens
 * every report, deck and dashboard in a tab of its own, with comments and exports). Their
 * shapes are validated here so a surface never receives a deck it cannot draw: a model
 * that sends a malformed one is told what was wrong and calls again.
 */
export const CANVAS_TYPES = [
  'chart',
  'table',
  'code',
  'form',
  'image',
  'markdown',
  'artifact',
  'deck',
  'dashboard',
] as const;

const chartData = z.object({
  chartType: z.enum(['bar', 'line', 'pie']),
  labels: z.array(z.string()).min(1).max(200),
  datasets: z
    .array(z.object({ label: z.string(), values: z.array(z.number()) }))
    .min(1)
    .max(12),
});

export const deckData = z.object({
  slides: z
    .array(
      z.object({
        title: z.string().min(1),
        subtitle: z.string().optional(),
        bullets: z.array(z.string()).max(12).optional(),
        body: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1)
    .max(60),
});

export const dashboardData = z.object({
  widgets: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('stat'),
          label: z.string(),
          value: z.string(),
          delta: z.string().optional(),
        }),
        chartData.extend({ kind: z.literal('chart'), title: z.string().optional() }),
        z.object({
          kind: z.literal('table'),
          title: z.string().optional(),
          headers: z.array(z.string()),
          rows: z.array(z.array(z.string())).max(500),
        }),
        z.object({ kind: z.literal('text'), title: z.string().optional(), content: z.string() }),
      ]),
    )
    .min(1)
    .max(40),
});

const SHAPES: Partial<Record<(typeof CANVAS_TYPES)[number], z.ZodType>> = {
  deck: deckData,
  dashboard: dashboardData,
};

export const canvasTool = tool({
  description:
    'Display rich content as a visual canvas component the person can open, comment on and export: a report (markdown), a slide deck (deck), a dashboard, a chart, a table, code, a form or an image. Not for a simple text answer. To revise one, call it again with the same title and type.',
  inputSchema: z.object({
    type: z.enum(CANVAS_TYPES).describe('The type of canvas component to create'),
    title: z.string().describe('Title for the canvas component'),
    data: z
      .any()
      .describe(
        'Component data. For chart: { chartType: "bar"|"line"|"pie", labels, datasets: [{ label, values }] }. For table: { headers, rows }. For code: { language, code }. For form: { fields }. For image: { url, alt? }. For markdown (a report or document): { content }. For artifact: { content, language? }. For deck: { slides: [{ title, subtitle?, bullets?: string[], body?: markdown, notes? }] }. For dashboard: { widgets: [ { kind: "stat", label, value, delta? } | { kind: "chart", title?, chartType, labels, datasets } | { kind: "table", title?, headers, rows } | { kind: "text", title?, content: markdown } ] }',
      ),
  }),
  execute: async ({ type, title, data }) => {
    const shape = SHAPES[type];
    if (shape) {
      const parsed = shape.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          error: `The ${type} was not drawn: ${issue ? `${issue.path.join('.') || 'data'}: ${issue.message}` : 'its data is invalid'}. Send it again in the shape the tool describes.`,
        };
      }
      data = parsed.data;
    }
    return {
      id: randomUUID(),
      type,
      title,
      data,
      message: 'Canvas component created',
    };
  },
});
