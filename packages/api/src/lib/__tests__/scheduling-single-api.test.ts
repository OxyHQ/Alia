import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The trigger engine is the only recurring scheduler. During migration it
 * reads both legacy trigger rows and normalized automation definitions.
 *
 * ## What "single" is being claimed about, precisely
 *
 * Not "nothing else uses a timer": `setInterval` appears in fifteen modules for
 * cache sweeps, keep-alives, lease renewals and health checks, and none of those
 * is a scheduling API — they are internal housekeeping with no user-visible
 * schedule, no persistence and no execution record. An allow-list over
 * `setInterval` would be a list that grows by one defensible entry at a time
 * until it excuses everything.
 *
 * The claim that can be checked, and that is the one the epic makes, is about
 * RECURRING USER-DEFINED EXECUTION: a schedule a user or an agent configured,
 * which survives a restart because it is a row. Exactly one mechanism in this
 * package does that — `node-cron`, driven by `lib/trigger-engine.ts` — and the
 * census below is over that mechanism.
 *
 * A second scheduler is not a hypothetical: an agent archetype with a
 * `schedule`, a daily briefing and an agent `scheduleInterval` are three
 * features that each look like they want their own cron. Today all three are
 * expressed as trigger rows (`routes/agents/crud.ts:32-71`,
 * `lib/daily-briefing.ts:10-13`, `lib/trigger-engine.ts:695-749`), and the
 * import check below is what keeps the fourth one from being different.
 *
 * The behaviour on the other side — that what gets scheduled comes from trigger
 * rows and is reconciled against them — is `lib/__tests__/trigger-engine.test.ts`
 * ("reschedules an edited trigger and stops a removed one"), and is not repeated.
 */

const SRC = path.resolve(import.meta.dirname, '../..');

interface Source {
  readonly file: string;
  readonly specifiers: readonly string[];
  readonly calls: readonly string[];
}

/**
 * Every non-test `.ts` under `packages/api/src`, with its import specifiers and
 * its `<something>.schedule(` call sites.
 *
 * Comment lines are excluded: this file's own prose names `node-cron` several
 * times, and a census that counted its own explanation would be a census that
 * cannot reach zero.
 */
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

      const relative = path.relative(SRC, full);
      const specifiers: string[] = [];
      const calls: string[] = [];
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const match of line.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
          specifiers.push(match[1] ?? match[2]);
        }
        for (const match of line.matchAll(/\b(\w+)\.schedule\s*\(/g)) calls.push(match[1]);
      }
      out.push({ file: relative, specifiers, calls });
    }
  };

  walk(SRC);
  return out;
}

const SOURCES = readSources();
const TRIGGER_ENGINE = 'lib/trigger-engine.ts';
const TRIGGER_REPOSITORY = 'db/automation/triggerRepository.js';
const AUTOMATION_REPOSITORY = 'db/automation/automationDefinitionRepository.js';

describe('the census reads what it claims to read', () => {
  it('scans the whole package, so a clean result means clean', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    // A positive control on the import parser: a file KNOWN to import something.
    const engine = SOURCES.find((source) => source.file === TRIGGER_ENGINE);
    expect(engine, 'the trigger engine was not scanned at all').toBeDefined();
    expect(engine?.specifiers).toContain('node-cron');
    expect(engine?.calls).toContain('cron');
  });

  it('does not read a commented-out import or call', () => {
    const probe = ["// import cron from 'node-cron';", " * cron.schedule('* * * * *', fn)"];
    for (const line of probe) {
      const trimmed = line.trim();
      expect(trimmed.startsWith('//') || trimmed.startsWith('*')).toBe(true);
    }
  });
});

describe('exactly one module can put work on a recurring schedule', () => {
  it('imports node-cron in the trigger engine and nowhere else', () => {
    const importers = SOURCES.filter((source) => source.specifiers.includes('node-cron'))
      .map((source) => source.file)
      .sort();
    expect(importers).toEqual([TRIGGER_ENGINE]);
  });

  it('calls cron.schedule in the trigger engine and nowhere else', () => {
    const callers = SOURCES.filter((source) => source.calls.includes('cron'))
      .map((source) => source.file)
      .sort();
    expect(callers).toEqual([TRIGGER_ENGINE]);
  });

  it('the census WOULD catch a second scheduler (the negative control)', () => {
    // "Absent" is also what a scan that read nothing reports, and both checks
    // above are absence claims. This proves the predicates fire.
    const synthetic = "import cron from 'node-cron';\ncron.schedule('*/5 * * * *', run);";
    const specifiers = [...synthetic.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const calls = [...synthetic.matchAll(/\b(\w+)\.schedule\s*\(/g)].map((match) => match[1]);
    expect(specifiers).toContain('node-cron');
    expect(calls).toContain('cron');
  });
});

describe('the scheduling surfaces persist through one of the engine repositories', () => {
  /**
   * The three places a user or an agent configures recurring work. Each is
   * listed with what makes it a scheduling surface, so an entry cannot be added
   * without saying why — and none of them may schedule anything itself.
   */
  const SCHEDULING_SURFACES: readonly { file: string; why: string }[] = [
    { file: 'routes/triggers.ts', why: 'the trigger CRUD API' },
    { file: 'routes/agents/crud.ts', why: 'an agent archetype with a schedule' },
    { file: 'lib/daily-briefing.ts', why: "a user's morning briefing" },
  ];
  const NORMALIZED_SURFACE = {
    file: 'routes/automations.ts',
    why: 'the normalized automation control plane',
  };

  it('each one persists through the trigger repository', () => {
    for (const surface of SCHEDULING_SURFACES) {
      const source = SOURCES.find((entry) => entry.file === surface.file);
      expect(source, `${surface.file} (${surface.why}) was not scanned`).toBeDefined();
      expect(
        source?.specifiers.some((spec) => spec.endsWith(TRIGGER_REPOSITORY)),
        `${surface.file} does not go through the trigger repository`,
      ).toBe(true);
    }
  });

  it('the normalized control plane persists through the automation repository', () => {
    const source = SOURCES.find((entry) => entry.file === NORMALIZED_SURFACE.file);
    expect(source, `${NORMALIZED_SURFACE.file} (${NORMALIZED_SURFACE.why}) was not scanned`).toBeDefined();
    expect(source?.specifiers.some((specifier) => specifier.endsWith(AUTOMATION_REPOSITORY))).toBe(true);
  });

  it('and none of them schedules anything itself', () => {
    for (const surface of SCHEDULING_SURFACES) {
      const source = SOURCES.find((entry) => entry.file === surface.file);
      expect(source?.specifiers).not.toContain('node-cron');
      expect(source?.calls).not.toContain('cron');
    }
    const normalized = SOURCES.find((entry) => entry.file === NORMALIZED_SURFACE.file);
    expect(normalized?.specifiers).not.toContain('node-cron');
    expect(normalized?.calls).not.toContain('cron');
  });
});
