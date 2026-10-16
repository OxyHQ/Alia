import { describe, expect, it } from 'vitest';
import { englishCopy } from '@alia.onl/sdk/model';
import { COPY_EN } from '../../../../../alia-chat/src/lib/copy-en';
import { translator } from '@/shared/testing/translate';
import en from '../locales/en.json';
import es from '../locales/es.json';

/**
 * The chat's words are asked of the app by key (`labels.t`), and the SDK carries the English for a
 * host without a catalogue. The two must not drift: every key the SDK asks for exists in BOTH of
 * the app's catalogues, and the SDK's English is the app's English.
 *
 * (The catalogue is the app's to translate; the SDK ships English only.)
 */
type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | Tree | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

const keys = Object.keys(COPY_EN);

describe('the SDK’s English against the app’s catalogues', () => {
  it('is not empty (the gate reads something)', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it.each(keys)('%s exists in the English and Spanish catalogues', (key) => {
    expect(lookup(en as Tree, key), `en.json lacks ${key}`).toBeDefined();
    expect(lookup(es as Tree, key), `es.json lacks ${key}`).toBeDefined();
  });

  it.each(keys)('%s reads the same in English', (key) => {
    const entry = COPY_EN[key];
    const app = lookup(en as Tree, key);
    expect(JSON.stringify(entry)).toBe(JSON.stringify(typeof app === 'string' ? app : app));
  });
});

describe('the activity rows in Spanish, through the app’s catalogue', () => {
  const t = translator('es');

  it('names the plan it showed and counts its steps', async () => {
    const { auditText, buildAuditTimeline } = await import('@alia.onl/sdk/model');
    const [entry] = buildAuditTimeline([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        plan: { planId: 'p1', steps: [{}, {}, {}] },
      } as never,
    ]);
    expect(auditText(entry!.label, t)).toBe('Plan');
    expect(auditText(entry!.description, t)).toBe('3 pasos');
  });

  it('names a research phase it knows, and any other as researching', async () => {
    const { auditText, buildAuditTimeline } = await import('@alia.onl/sdk/model');
    const phase = (value: string) =>
      auditText(
        buildAuditTimeline([
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            researchProgress: { phase: value, isComplete: false },
          } as never,
        ])[0]!.label,
        t,
      );
    expect(phase('synthesizing')).toBe('Investigación: sintetizando hallazgos');
    expect(phase('something_new')).toBe('Investigando');
  });

  it('translates a tool the catalogue has words for', async () => {
    const { buildAuditTimeline, auditText } = await import('@alia.onl/sdk/model');
    const [entry] = buildAuditTimeline([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolInvocations: [
          { toolCallId: 'c1', toolName: 'webSearch', state: 'result', args: { query: 'lluvia' } },
        ],
      },
    ]);
    expect(auditText(entry!.label, t)).toBe('Buscando en la web');
  });
});

describe('the SDK’s own English translator', () => {
  it('interpolates a parameter, picks the plural and answers an unknown key with itself', () => {
    expect(englishCopy('thought.outputs')).toBe('Outputs');
    expect(englishCopy('thought.openOutput', { name: 'a.md' })).toBe('Open a.md in the canvas');
    expect(englishCopy('thought.audit.planSteps', { count: 1 })).toBe('1 step');
    expect(englishCopy('thought.audit.planSteps', { count: 3 })).toBe('3 steps');
    expect(englishCopy('no.such.key')).toBe('no.such.key');
  });
});
