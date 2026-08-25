import { describe, it, expect } from 'vitest';
import { buildIdentityGuard } from '../identity-guard.js';

// Providers / foundation-model names that must NEVER leak to users. These are
// the exact tokens the guard is responsible for keeping out of Alia's mouth.
const FORBIDDEN_PROVIDERS = [
  'Google', 'Gemini', 'OpenAI', 'GPT', 'ChatGPT', 'Anthropic', 'Claude',
  'Meta', 'Llama', 'Mistral', 'DeepSeek', 'Groq', 'xAI', 'Grok',
];

describe('buildIdentityGuard', () => {
  it('interpolates the active Alia model name when provided', () => {
    const guard = buildIdentityGuard({ modelName: 'Alia V1' });
    expect(guard).toContain('You are Alia V1');
    expect(guard).toContain('answer "Alia V1"');
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
    const guard = buildIdentityGuard({ modelName: 'Alia V1' });
    for (const provider of FORBIDDEN_PROVIDERS) {
      expect(guard).toContain(provider);
    }
  });

  it('asserts it is an AI without denying being one', () => {
    const guard = buildIdentityGuard({ modelName: 'Alia V1' });
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
  const AGENT = { agentName: 'Pepe', modelName: 'Alia V1' };

  it('names the agent, not the model, as who it is', () => {
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('You are Pepe,');
    // The sentence that made this wrong, gone in both its forms.
    expect(guard).not.toContain('You are Alia V1,');
    expect(guard).not.toContain('ONLY name you ever give for yourself');
  });

  it('still lets it name the platform and the Alia model powering it', () => {
    // Refusing a question that has a true, route-free answer is what pushes a
    // person to keep digging. Both facts are the product's own.
    const guard = buildIdentityGuard(AGENT);

    expect(guard).toContain('Alia');
    expect(guard).toContain('Alia V1 is the Alia model powering this conversation');
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
    const guard = buildIdentityGuard({ agentName: '  ', modelName: 'Alia V1' });

    expect(guard).toContain('You are Alia V1,');
    expect(guard).not.toContain('You are ,');
  });
});
