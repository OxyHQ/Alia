import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A screen has ONE header. The layout draws Bloom's page header over every page from the options the
 * page declares; the agent editor draws its own (`AgentCreator`: undo, title, close), so its routes
 * are the ones the layout leaves bare. These read the sources, so they pin the shape without
 * rendering the shell.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const layout = read('../_layout.tsx');
const EDIT_ROUTES = [{ file: '../[username]/edit.tsx', name: '[username]/edit' }];

describe('the agent editor screen has one header', () => {
  it('is left bare by the layout: no shell page header above the editor’s own', () => {
    expect(layout).toMatch(/OWN_HEADER_ROUTES = new Set\(/);
    for (const { name } of EDIT_ROUTES) expect(layout).toContain(`'${name}'`);
    // The container's `header` replaces its default bar, so an empty one is "no bar here".
    expect(layout).toMatch(/OWN_HEADER_ROUTES\.has\(route\.name\)[\s\S]*header=\{<><\/>\}/);
    // And that branch comes before the one that builds the shell's page header.
    expect(layout.indexOf('OWN_HEADER_ROUTES.has')).toBeLessThan(
      layout.indexOf('<ShellPageHeader'),
    );
  });

  it.each(EDIT_ROUTES)('$name declares no navigation header of its own either', ({ file }) => {
    const source = read(file);
    expect(source).toContain('headerShown: false');
    expect(source).not.toMatch(/title:|headerBackVisible|headerRight/);
    expect(source).toContain('AgentEditorLoader');
  });

  it('closes through the editor’s own control, which leaves the screen', () => {
    for (const { file } of EDIT_ROUTES) expect(read(file)).toMatch(/onClose=\{/);
  });
});
