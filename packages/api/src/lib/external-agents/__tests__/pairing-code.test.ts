import { describe, expect, it } from 'vitest';
import {
  generatePairingCode,
  hashPairingCode,
  isWellFormedPairingCode,
  normalizePairingCode,
} from '../pairing-code.js';
import { buildInvitePrompt, inviteLocaleOf } from '../invite-prompt.js';
import { externalHistoryOf } from '../history.js';

describe('pairing codes', () => {
  it('generates XXXX-XXXX-XXXX codes without look-alike symbols', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(isWellFormedPairingCode(code)).toBe(true);
    }
  });

  it('does not repeat across a thousand draws', () => {
    const seen = new Set(Array.from({ length: 1000 }, generatePairingCode));
    expect(seen.size).toBe(1000);
  });

  it('hashes the same for any spelling of one code', () => {
    const code = 'ABCD-EFGH-JKMN';
    expect(hashPairingCode('abcd efgh jkmn')).toBe(hashPairingCode(code));
    expect(hashPairingCode('abcdefghjkmn')).toBe(hashPairingCode(code));
    expect(hashPairingCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPairingCode('ABCD-EFGH-JKMP')).not.toBe(hashPairingCode(code));
  });

  it('rejects codes of the wrong length', () => {
    expect(isWellFormedPairingCode('ABCD-EFGH')).toBe(false);
    expect(isWellFormedPairingCode('')).toBe(false);
    expect(normalizePairingCode('ab-cd')).toBe('ABCD');
  });
});

describe('invite prompt', () => {
  it('carries the code and the command, in either language, and no token', () => {
    for (const locale of ['en', 'es'] as const) {
      const prompt = buildInvitePrompt({ code: 'ABCD-EFGH-JKMN', locale });
      expect(prompt).toContain('connect --code ABCD-EFGH-JKMN');
      expect(prompt).toContain('--cli <claude|codex|opencode>');
      expect(prompt).toContain('10');
    }
    expect(inviteLocaleOf('es-ES')).toBe('es');
    expect(inviteLocaleOf(undefined)).toBe('en');
  });
});

describe('externalHistoryOf', () => {
  it('splits the last user message from what came before', () => {
    const { task, history } = externalHistoryOf([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    ]);
    expect(task).toBe('fix the bug');
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });
});
