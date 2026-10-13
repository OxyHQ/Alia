import { describe, expect, it } from 'vitest';
import { extractCitationSources, linkifyCitations } from '../../src/lib/citations';
import type { ToolInvocation } from '../../src/types';

const research: ToolInvocation = {
  toolName: 'deepResearch',
  state: 'result',
  result: { sources: [{ id: 1, url: 'https://a.test/x', title: 'A "quoted" title' }] },
};

describe('linkifyCitations', () => {
  it('links a [n] marker that names a source, folding quotes out of its title', () => {
    const sources = extractCitationSources([research]);
    const out = linkifyCitations('Growing [1].', sources);
    expect(out).toBe(`Growing [1](https://a.test/x "Source 1: A 'quoted' title").`);
  });

  it('leaves a marker with no source as text, and links nothing without sources', () => {
    expect(linkifyCitations('See [2].', extractCitationSources([research]))).toBe('See [2].');
    expect(linkifyCitations('See [1].', [])).toBe('See [1].');
  });

  it('reads the live sources of a research answer not yet persisted', () => {
    const sources = extractCitationSources(undefined, [
      { id: 3, url: 'https://b.test', title: 'B' },
    ]);
    expect(linkifyCitations('[3]', sources)).toContain('(https://b.test ');
  });
});
