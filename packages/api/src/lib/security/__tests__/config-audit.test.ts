import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit records for configuration changes — epic #139 workstream 15, *"Add audit
 * logs for configuration changes that affect model/routing behavior."*
 *
 * The record itself is checked here: it carries actor, before, after and a
 * timestamp, and it cannot carry content, because its payload is a per-resource
 * allow-list. Which writers emit it is checked where the writers are:
 * `lib/routing/__tests__/routing-config-audit.test.ts` maps every `plans`
 * writer, the only configuration table left since the provider catalogue
 * tables were dropped.
 */


/** Captured `log.info` payloads, one array shared by the fake child logger. */
const emitted: { payload: Record<string, unknown>; message: string }[] = [];

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: (payload: Record<string, unknown>, message: string) => {
      emitted.push({ payload, message });
    },
  }),
}));

const { AUDITED_FIELDS, auditedFields, recordConfigChange } = await import('../config-audit.js');

beforeEach(() => {
  emitted.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  The record itself                                                          */
/* -------------------------------------------------------------------------- */

describe('a configuration audit record (#139 ws15)', () => {
  it('carries actor, before, after and a timestamp', () => {
    recordConfigChange({
      resource: 'plan',
      action: 'update',
      target: 'pro',
      actor: { kind: 'user', id: 'oxy-user-1' },
      // Through the projection, as a real caller does. Since `AuditedFields` is
      // branded, an object literal no longer compiles here — which is the point
      // of the brand, and makes this fixture the shape the writers produce.
      before: auditedFields('plan', { isActive: true }),
      after: auditedFields('plan', { isActive: false }),
    });

    expect(emitted).toHaveLength(1);
    const { payload } = emitted[0];
    expect(payload.event).toBe('config.change');
    expect(payload.resource).toBe('plan');
    expect(payload.action).toBe('update');
    expect(payload.target).toBe('pro');
    expect(payload.actor).toEqual({ kind: 'user', id: 'oxy-user-1' });
    expect(payload.before).toEqual({ isActive: true });
    expect(payload.after).toEqual({ isActive: false });
    expect(String(payload.at)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('cannot carry prompt or response content', () => {
    /**
     * Two directions. First: no allow-list names a content-shaped field.
     *
     * Matched per camelCase WORD rather than as a substring, which is not
     * fussiness — `contextWindow` contains `text`, and a substring predicate
     * reports it as content on a field that is a token count. A predicate that
     * cries wolf on a legitimate field is a predicate somebody deletes.
     */
    const CONTENT_WORDS = new Set([
      'message',
      'messages',
      'content',
      'prompt',
      'completion',
      'response',
      'transcript',
      'body',
      'text',
    ]);
    const carriesContent = (field: string): boolean =>
      field
        .split(/(?=[A-Z])/)
        .map((word) => word.toLowerCase())
        .some((word) => CONTENT_WORDS.has(word));

    for (const [resource, fields] of Object.entries(AUDITED_FIELDS)) {
      for (const field of fields) {
        expect(carriesContent(field), `${resource}.${field}`).toBe(false);
      }
      // The floor: the allow-list for this resource is not empty, so "no field
      // matches" is not true of nothing.
      expect(fields.length, resource).toBeGreaterThan(0);
    }
    // The controls, in both directions: it catches content and leaves the
    // legitimate field that contains one of the words alone.
    expect(carriesContent('systemPrompt')).toBe(true);
    expect(carriesContent('lastCompletion')).toBe(true);
    expect(carriesContent('contextWindow')).toBe(false);

    // Second, and the one that matters: a row that DOES carry content has it
    // dropped rather than passed through.
    const projected = auditedFields('plan', {
      planId: 'pro',
      isActive: true,
      systemPrompt: 'you are a helpful assistant',
      lastCompletion: 'hello there',
    });
    expect(projected).toEqual({ planId: 'pro', isActive: true });
  });

  it('projects null to null, so a create and a delete need no special case', () => {
    expect(auditedFields('plan', null)).toBeNull();
    expect(auditedFields('plan', undefined)).toBeNull();
  });
});
