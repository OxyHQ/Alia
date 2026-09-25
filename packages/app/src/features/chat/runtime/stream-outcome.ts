/** Evidence the client may use to decide whether a streamed turn answered. */
export interface StreamOutputEvidence {
  realOutputChars: number;
  agentOutputChars: number;
  durableArtifactCount: number;
  /** Progress only. Deliberately not sufficient for success. */
  toolInvocationCount: number;
}

/**
 * A successful turn needs a user-facing answer or durable product output.
 * Reasoning and ordinary tool cards are progress; accepting either on stream
 * close leaves an empty assistant bubble that looks successfully completed.
 */
export function hasUsableStreamOutput(evidence: StreamOutputEvidence): boolean {
  return evidence.realOutputChars > 0 ||
    evidence.agentOutputChars > 0 ||
    evidence.durableArtifactCount > 0;
}
