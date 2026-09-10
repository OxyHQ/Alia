import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../../..');

function productionSources(directory: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        result.push(full);
      }
    }
  };
  visit(directory);
  return result;
}

function read(file: string): string {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
}

describe('structured automation cutover', () => {
  it('keeps the app on the typed automation API without useTools', () => {
    const files = productionSources(path.join(REPOSITORY_ROOT, 'packages/app'));
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return /\/triggers\b/.test(source) || /\buseTools\b/.test(source);
    }).map((file) => path.relative(REPOSITORY_ROOT, file));
    expect(offenders).toEqual([]);
    expect(read('packages/app/lib/hooks/use-automations.ts')).toContain('API_ROUTES.automations.create');
  });

  it('keeps scheduler, dispatcher and agent updates off the legacy runtime', () => {
    const runtimeFiles = [
      'packages/api/src/lib/trigger-engine.ts',
      'packages/api/src/lib/automation-dispatcher.ts',
      'packages/api/src/lib/tool-pipeline.ts',
      'packages/api/src/routes/agents/crud.ts',
    ];
    for (const file of runtimeFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/\buseTools\b/);
      expect(source, file).not.toContain('triggerRepository');
    }
    expect(read('packages/api/src/lib/trigger-engine.ts'))
      .toContain('listSchedulableAutomationDefinitions');
  });
});
