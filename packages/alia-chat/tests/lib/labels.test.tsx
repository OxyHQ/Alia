import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  AliaChatLabelsProvider,
  DEFAULT_LABELS,
  type AliaChatLabels,
  useLabels,
} from '../../src/lib/labels';

function read(labels?: Partial<AliaChatLabels>): AliaChatLabels {
  let seen: AliaChatLabels | null = null;
  function Probe() {
    seen = useLabels();
    return null;
  }
  act(() => {
    TestRenderer.create(
      labels === undefined ? (
        <Probe />
      ) : (
        <AliaChatLabelsProvider labels={labels}>
          <Probe />
        </AliaChatLabelsProvider>
      ),
    );
  });
  if (seen === null) throw new Error('The probe did not render.');
  return seen;
}

describe('chat labels', () => {
  it('are English with no provider at all', () => {
    expect(read()).toBe(DEFAULT_LABELS);
  });

  it('take the host overrides and keep every other default', () => {
    const labels = read({ clear: 'Borrar', thoughtFor: (seconds) => `Pensó ${seconds} s` });

    expect(labels.clear).toBe('Borrar');
    expect(labels.thoughtFor(4)).toBe('Pensó 4 s');
    expect(labels.back).toBe(DEFAULT_LABELS.back);
    expect(labels.t).toBe(DEFAULT_LABELS.t);
  });

  it('pluralise the counts the way the defaults promise', () => {
    expect(DEFAULT_LABELS.thoughtFor(12)).toBe('Thought for 12 seconds');
  });

  it('carry an English work log whose plurals follow the count', () => {
    expect(DEFAULT_LABELS.t('chat.bloom.sourceCount', { count: 1 })).toBe('1 source');
    expect(DEFAULT_LABELS.t('chat.bloom.sourceCount', { count: 0 })).toBe('0 sources');
    expect(DEFAULT_LABELS.t('chat.bloom.resultCount', { count: 4 })).toBe('4 results');
    expect(DEFAULT_LABELS.t('tasks.tool.done.shellExec')).toBe('Ran command');
  });

  it('let a host bring its own work-log translator', () => {
    const labels = read({ t: (key) => `es:${key}` });

    expect(labels.t('chat.bloom.visited')).toBe('es:chat.bloom.visited');
  });
});

it('uses Spanish for regional Spanish locales without host translations', () => {
  const labels = read({ locale: 'es-ES' });
  expect(labels.greetingNamed('Nate')).toBe('Hola Nate, ¿qué tienes en mente?');
  expect(labels.composerSend).toBe('Enviar mensaje');
  expect(labels.voiceControls.end).toBe('Colgar');
  expect(labels.voiceError('mic-denied')).toBe('Se necesita permiso para usar el micrófono');
  expect(labels.t('chat.bloom.sourceCount', { count: 1 })).toBe('1 fuente');
  expect(labels.t('chat.bloom.sourceCount', { count: 3 })).toBe('3 fuentes');
  expect(labels.locale).toBe('es-ES');
});

it('keeps the Spanish catalogue through nested label overrides', () => {
  let seen: AliaChatLabels | undefined;
  function Probe() {
    seen = useLabels();
    return null;
  }
  act(() => {
    TestRenderer.create(
      <AliaChatLabelsProvider labels={{ locale: 'es' }}>
        <AliaChatLabelsProvider labels={{ clear: 'Vaciar' }}>
          <Probe />
        </AliaChatLabelsProvider>
      </AliaChatLabelsProvider>,
    );
  });
  expect(seen?.clear).toBe('Vaciar');
  expect(seen?.composerSend).toBe('Enviar mensaje');
  expect(seen?.t('chat.bloom.sourceCount', { count: 2 })).toBe('2 fuentes');
});
