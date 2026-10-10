import { describe, expect, it, vi } from 'vitest';

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Machine turns must not read product authority');
  }),
);
vi.mock('../../db/index.js', () => ({ getDb: forbidden }));
import { ToolPipeline } from '../tool-pipeline.js';

describe('app-only machine tool assembly', () => {
  it('returns no tools, clock helper, application catalog or source reads', () => {
    const result = ToolPipeline.forMachineTurn();
    expect(result.tools).toEqual({});
    expect(result.toolNameMapping.size).toBe(0);
    expect(result.appCatalogPrompt).toBe('');
    expect(forbidden).not.toHaveBeenCalled();
  });
});
