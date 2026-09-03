import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Recurring user work has one control plane and one elected scheduler:
 * `/automations` persists normalized definitions, while trigger-engine reads
 * only those definitions. Retired trigger rows remain read-only history.
 */

const SRC = path.resolve(import.meta.dirname, '../..');

interface Source {
  readonly file: string;
  readonly specifiers: readonly string[];
  readonly calls: readonly string[];
}

function readSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const specifiers: string[] = [];
      const calls: string[] = [];
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const match of line.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
          const specifier = match[1] ?? match[2];
          if (specifier) specifiers.push(specifier);
        }
        for (const match of line.matchAll(/\b(\w+)\.schedule\s*\(/g)) {
          const caller = match[1];
          if (caller) calls.push(caller);
        }
      }
      out.push({ file: path.relative(SRC, full), specifiers, calls });
    }
  };
  walk(SRC);
  return out;
}

const SOURCES = readSources();
const TRIGGER_ENGINE = 'lib/trigger-engine.ts';
const TRIGGER_REPOSITORY = 'db/automation/triggerRepository.js';
const AUTOMATION_REPOSITORY = 'db/automation/automationDefinitionRepository.js';

describe('one structured scheduling control plane', () => {
  it('scans the production package and finds exactly one cron owner', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES.filter((source) => source.specifiers.includes('node-cron')).map((source) => source.file))
      .toEqual([TRIGGER_ENGINE]);
    expect(SOURCES.filter((source) => source.calls.includes('cron')).map((source) => source.file))
      .toEqual([TRIGGER_ENGINE]);
  });

  it('persists new schedules through the normalized automation repository', () => {
    const route = SOURCES.find((source) => source.file === 'routes/automations.ts');
    expect(route?.specifiers.some((specifier) => specifier.endsWith(AUTOMATION_REPOSITORY))).toBe(true);
    expect(route?.specifiers).not.toContain('node-cron');
    expect(route?.calls).not.toContain('cron');
  });

  it('does not load the retired trigger repository in the scheduler or dispatcher', () => {
    for (const file of [TRIGGER_ENGINE, 'lib/automation-dispatcher.ts']) {
      const source = SOURCES.find((entry) => entry.file === file);
      expect(source, `${file} was not scanned`).toBeDefined();
      expect(source?.specifiers.some((specifier) => specifier.endsWith(TRIGGER_REPOSITORY))).toBe(false);
    }
  });
});
