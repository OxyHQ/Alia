import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No agent asks for approval (ADR 0020 §3, Enforcement "No approvals").
 *
 * The behaviour is pinned by `lib/__tests__/oxy-no-approvals.test.ts` (every
 * Oxy tool, a payment and a deletion included, executes directly) and
 * `lib/agent/__tests__/governance-policy.test.ts` (R3 and a blocking threat
 * still block; R2 and a threat warning run, flagged). This is the gate that
 * keeps the machinery from coming back under its old names: a proposal path,
 * an approval gate, an approval row or an approval event in product source.
 */

const SRC = path.resolve(import.meta.dirname, '..');

const RETIRED = [
  'oxyApprovals',
  'OxyApprovalGate',
  'reviewKindOf',
  'requestApproval',
  'approval_required',
  'agent_approval_requests',
  'approvals:changed',
  'alia.approval_request',
  'alia.approval_result',
  'agent-approval-response',
  'approval.requested',
];

function productSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...productSources(full));
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function hits(files: readonly string[], tokens: readonly string[]): string[] {
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return tokens
      .filter((token) => source.includes(token))
      .map((token) => `${path.relative(SRC, file)}: ${token}`);
  });
}

describe('no approval machinery in product source', () => {
  const files = productSources(SRC);

  it('reads the product source at all', () => {
    expect(files.length).toBeGreaterThan(200);
    // A positive control: the scanner finds a token it is known to find.
    expect(hits(files, ['applyRuntimePolicy'])).not.toEqual([]);
  });

  it('names none of the retired approval paths, rows or events', () => {
    expect(hits(files, RETIRED)).toEqual([]);
  });
});
