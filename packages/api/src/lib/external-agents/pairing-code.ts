import { createHash, randomInt } from 'node:crypto';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GROUPS,
  PAIRING_CODE_GROUP_LENGTH,
} from '../../domain/external-agent.js';

/** `XXXX-XXXX-XXXX`: 12 symbols over 31 → ~59 bits, drawn with a CSPRNG. */
export function generatePairingCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < PAIRING_CODE_GROUPS; g++) {
    let group = '';
    for (let i = 0; i < PAIRING_CODE_GROUP_LENGTH; i++) {
      group += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Upper-cases and strips anything outside the alphabet, so `abcd efgh…` and `ABCD-EFGH-…` match. */
export function normalizePairingCode(raw: string): string {
  const symbols = [...raw.toUpperCase()].filter((c) => PAIRING_CODE_ALPHABET.includes(c));
  const size = PAIRING_CODE_GROUP_LENGTH;
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += size) groups.push(symbols.slice(i, i + size).join(''));
  return groups.join('-');
}

export function hashPairingCode(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code)).digest('hex');
}

export function isWellFormedPairingCode(raw: string): boolean {
  const normalized = normalizePairingCode(raw);
  return normalized.length === PAIRING_CODE_GROUPS * (PAIRING_CODE_GROUP_LENGTH + 1) - 1;
}
