import { describe, expect, it } from 'vitest';
import { hasUsableStreamOutput, type StreamOutputEvidence } from '../stream-outcome';

const evidence = (overrides: Partial<StreamOutputEvidence> = {}): StreamOutputEvidence => ({
  realOutputChars: 0,
  agentOutputChars: 0,
  durableArtifactCount: 0,
  toolInvocationCount: 0,
  ...overrides,
});

describe('stream completion evidence', () => {
  it('does not treat five completed tool steps as an assistant answer', () => {
    expect(hasUsableStreamOutput(evidence({ toolInvocationCount: 5 }))).toBe(false);
  });

  it('accepts real text, delegated-agent output, and durable artifacts', () => {
    expect(hasUsableStreamOutput(evidence({ realOutputChars: 1 }))).toBe(true);
    expect(hasUsableStreamOutput(evidence({ agentOutputChars: 1 }))).toBe(true);
    expect(hasUsableStreamOutput(evidence({ durableArtifactCount: 1 }))).toBe(true);
  });
});
