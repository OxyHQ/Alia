import { describe, expect, it } from 'vitest';
import { SubjectTypeSchema } from '@oxyhq/crowdsource-contracts';
import { deliverableTypes, subjectProviderFor } from '../subjects/registry.js';
import { ReportedType } from '../../../domain/report.js';

/**
 * The delivered surface, pinned.
 *
 * The difference between a delivered type and a local-only one is invisible in a
 * 201 — both answer the reporter identically — so registering a provider, or
 * forgetting to, is a change no response body would reveal. Pinning the set makes
 * widening it a deliberate act with an argument attached.
 */

describe('subject registry', () => {
  it('delivers exactly the three published artefacts', () => {
    expect(deliverableTypes().sort()).toEqual(['agent', 'agent_review', 'skill']);
  });

  it('declares §5.4-valid subject types', () => {
    for (const reportedType of deliverableTypes()) {
      const provider = subjectProviderFor(reportedType);
      expect(provider).toBeDefined();
      expect(SubjectTypeSchema.safeParse(provider?.subjectType).success).toBe(true);
    }
  });

  it('uses the standard commerce.review type for a review rather than a custom one', () => {
    // A private vocabulary is for nouns the taxonomy has no name for. A person's
    // public opinion about somebody else's published thing already has one.
    expect(subjectProviderFor(ReportedType.AGENT_REVIEW)?.subjectType).toBe(
      'commerce.review',
    );
  });

  it('namespaces the two Alia-specific nouns', () => {
    expect(subjectProviderFor(ReportedType.AGENT)?.subjectType).toBe('custom.alia.agent');
    expect(subjectProviderFor(ReportedType.SKILL)?.subjectType).toBe('custom.alia.skill');
  });

  /**
   * The conclusion this integration is built on. Alia is an AI platform, so the
   * pressure to make a generated turn reportable will come back — from a support
   * ticket, from a well-meaning refactor, from somebody adding `chat.message`
   * because the contract has one. This test is where that argument has to be
   * re-made rather than quietly assumed.
   *
   * The reasons, in short: a conversation has no audience, so the only possible
   * reporter is the person who prompted it; naming that person as the subject's
   * author puts an Oxy Trust reputation effect on a human for text a model wrote;
   * and a generated turn cannot be judged without the prompt, so an honest report
   * necessarily discloses the user's own words.
   */
  it('has no provider for anything a model generated', () => {
    for (const generated of ['conversation', 'message', 'show', 'chat.message']) {
      expect(subjectProviderFor(generated)).toBeUndefined();
    }
  });

  /**
   * Accepted by the API, never delivered — Oxy owns identity, and a case opened in
   * Alia's tenant would name an actor only Oxy can act against.
   */
  it('accepts a reported account as a type but has no provider for it', () => {
    expect(Object.values(ReportedType)).toContain(ReportedType.USER);
    expect(subjectProviderFor(ReportedType.USER)).toBeUndefined();
    expect(deliverableTypes()).not.toContain(ReportedType.USER);
  });

  it('answers undefined for a type it has never heard of', () => {
    expect(subjectProviderFor('not_a_type')).toBeUndefined();
  });
});
