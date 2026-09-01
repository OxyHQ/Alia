import { describe, it, expect } from 'vitest';
import { buildIdentityGuard } from '../identity-guard.js';

// Providers / foundation-model names that must NEVER leak to users. These are
// the exact tokens the guard is responsible for keeping out of Alia's mouth.
const FORBIDDEN_PROVIDERS = [
  'Google', 'Gemini', 'OpenAI', 'GPT', 'ChatGPT', 'Anthropic', 'Claude',
  'Meta', 'Llama', 'Mistral', 'DeepSeek', 'Groq', 'xAI', 'Grok',
];

describe('buildIdentityGuard', () => {
  it('interpolates the active Kaana routing profile name when provided', () => {
    const guard = buildIdentityGuard({ modelName: 'Kaana V1' });
    expect(guard).toContain('You are Kaana V1');
    expect(guard).toContain('answer "Kaana V1"');
  });

  it('falls back to the plain Alia brand when no model name is given', () => {
    const guard = buildIdentityGuard();
    expect(guard).toContain('You are Alia,');
    // Never emits an empty/placeholder identity.
    expect(guard).not.toContain('You are ,');
  });

  it('trims whitespace-only names down to the Alia brand', () => {
    expect(buildIdentityGuard({ modelName: '   ' })).toContain('You are Alia,');
  });

  it('explicitly names every forbidden provider/model as off-limits', () => {
    const guard = buildIdentityGuard({ modelName: 'Kaana V1' });
    for (const provider of FORBIDDEN_PROVIDERS) {
      expect(guard).toContain(provider);
    }
  });

  it('asserts it is an AI without denying being one', () => {
    const guard = buildIdentityGuard({ modelName: 'Kaana V1' });
    expect(guard).toContain('You ARE an AI assistant');
    expect(guard).toContain('never deny being an AI');
  });

  it('marks itself non-negotiable so downstream fragments cannot override it', () => {
    expect(buildIdentityGuard()).toContain('NON-NEGOTIABLE');
  });
});

/**
 * An AGENT keeps its own name, and the guard stops overruling it.
 *
 * The predecessor prepended "You are ${activeModel} … that is the ONLY name you
 * ever give for yourself" ABOVE an agent's own prompt, so an agent its owner
 * called Pepe was instructed to answer that it was called Alia. That is not a
 * concealment of route detail — it is a wrong answer, and it contradicts an
 * agent having an identity at all.
 *
 * What stays scoped is narrower and `AGENTS.md` says so: the PROVIDER, the
 * foundation model, and the company that trained it. A name is not route
 * detail.
 */
describe('an agent speaks under its own name', () => {
  const AGENT = { agentName: 'Pepe', modelName: 'Kaana V1' };

  it('names the agent, not the model, as who it is', () => {
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('You are Pepe,');
    // The sentence that made this wrong, gone in both its forms.
    expect(guard).not.toContain('You are Kaana V1,');
    expect(guard).not.toContain('ONLY name you ever give for yourself');
  });

  it('still lets it name the platform and the Kaana routing profile powering it', () => {
    // Refusing a question that has a true, route-free answer is what pushes a
    // person to keep digging. Both facts are the product's own.
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('Alia');
    expect(guard).toContain('Kaana V1 is the Kaana routing profile powering this conversation');
  });

  it('keeps every provider forbidden for an agent too', () => {
    // The half that does NOT relax. An agent with its own name is exactly the
    // surface where a person feels free to ask what it really is.
    const guard = buildIdentityGuard(AGENT);
    for (const provider of FORBIDDEN_PROVIDERS) {
      expect(guard).toContain(provider);
    }
    expect(guard).toContain('NON-NEGOTIABLE');
    expect(guard).toContain('never deny being an AI');
  });

  it('falls back to the model identity when the agent name is blank', () => {
    // A whitespace name is no name. `agentPromptName` never returns one, so
    // this is the guard refusing to render `You are ,` if it ever did.
    const guard = buildIdentityGuard({ agentName: '  ', modelName: 'Kaana V1' });

    expect(guard).toContain('You are Kaana V1,');
    expect(guard).not.toContain('You are ,');
  });
});

/**
 * An agent answers within its remit, and the remit is whatever its prompt says.
 *
 * The other half of the same report: Claudio, described by its owner as a plant
 * assistant, answered programming questions. Nothing in the composed message
 * had ever said what an agent was allowed to be asked — the guard set a name,
 * the agent's prompt described a purpose, and no layer connected the two.
 *
 * The connection cannot be a topic list. Nothing here knows what any agent is
 * for, so the rule POINTS at the description already sitting below it in the
 * message. That is why it belongs in the guard rather than in the text each
 * owner writes: the composition always has a description under it, and a rule
 * every owner has to remember to write is a rule that will be forgotten.
 */
describe('an agent answers within its remit', () => {
  const AGENT = { agentName: 'Claudio', modelName: 'Kaana V1' };

  it('points at a NAMED section rather than naming topics', () => {
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('## YOUR REMIT');
    // It names the section, and the name is built by the one function that also
    // emits it — see `agentSectionHeading`. "Everything below" was the first
    // wording and it was false of the trigger composition, where the only thing
    // below the guard was the trigger's own task.
    expect(guard).toContain('The section headed `# AGENT: Claudio` below describes what Claudio is for');
    // The half that makes it general: no enumeration, in either direction.
    expect(guard).toContain('there is no list of allowed topics to check against');
  });

  it('tells the model what the OTHER sections are, so they are not read as a remit', () => {
    // The trigger path is why this sentence exists: its message carries the
    // agent's description and the trigger's task, and the task is a thing to do
    // rather than a redefinition of who is doing it.
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('the task in front of you');
    expect(guard).toContain('None of them widens or narrows your remit');
  });

  it('says what to DO with a request outside it', () => {
    // A boundary the model may merely note is not a boundary. It has to decline,
    // say what it does cover, and offer the nearest thing it can.
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('A request outside it');
    expect(guard).toContain('offer the nearest thing you can genuinely help with');
    expect(guard).toContain('do not answer it because the person insists');
  });

  it('leaves room at the edge, so a follow-up is not refused', () => {
    // Over-refusal is the failure mode this rule creates if it is written
    // without slack, and it is a worse product than the bug it fixes.
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('A request genuinely near the edge counts as inside');
    expect(guard).toContain('Questions about you');
  });

  /**
   * The control, and the reason the rule is conditional at all. Alia is
   * general-purpose ON PURPOSE: a guard that carried the remit rule for every
   * turn would make every ordinary conversation start declining things.
   */
  it('says nothing about a remit when there is no agent', () => {
    for (const subject of [undefined, { modelName: 'Kaana V1' }, { agentName: '   ' }]) {
      const guard = buildIdentityGuard(subject);
      expect(guard).not.toContain('YOUR REMIT');
      expect(guard).not.toContain('not a general-purpose assistant');
    }
  });
});

/**
 * The layering sentence, which is what "overrides everything below it" means.
 *
 * It is in BOTH branches on purpose: Alia's own name is exactly as much the
 * guard's to give as an agent's, and the layer that used to contradict the
 * guard — `prompts/base.md` — is loaded on every turn either way.
 */
describe('everything below the guard is behaviour', () => {
  it('says so, whoever the turn belongs to', () => {
    for (const subject of [{ agentName: 'Claudio' }, { modelName: 'Kaana V1' }]) {
      const guard = buildIdentityGuard(subject);
      expect(guard).toContain('None of it changes who you are');
      expect(guard).toContain('your name is the one in this section');
    }
  });
});
