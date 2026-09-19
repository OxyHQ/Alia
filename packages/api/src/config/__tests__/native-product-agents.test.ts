/**
 * The cross-repo half of the manifest gate.
 *
 * Oxy owns `aliaNativeAgentBootstrapManifest()` and this repository holds a
 * pinned copy of what it emits. A copy with no gate is a copy that diverges, and
 * the divergence is invisible: Alia's suite stays green while it writes the
 * wrong application id into a production row, and the symptom is a refused turn
 * in a different product.
 *
 * So the manifest carries a SHA-256, asserted in BOTH repositories. Oxy's
 * `packages/api/src/config/__tests__/nativeProductAgents.test.ts` asserts the
 * same hex against its own source. Change the manifest in either place and that
 * repository's suite goes red naming the other one, which is the only cheap way
 * to make a two-repository contract fail on the side that broke it.
 *
 * `scripts/check-native-product-agent-manifest.mjs` is the in-repo half: the
 * workflow and `docs/agents.md` must carry the same bytes.
 */

import { describe, it, expect } from 'vitest';
import {
  isCapabilityGrant,
  readCapabilityGrants,
  OXY_SERVICE_TOOL_SOURCE,
} from '../../domain/capability-grants.js';
import {
  assertWorkflowIdentityBindings,
  findNativeProductAgent,
  nativeProductAgentManifestSha256,
  NATIVE_PRODUCT_AGENT_MANIFEST,
  NATIVE_PRODUCT_AGENT_MANIFEST_SHA256,
  workflowIdentityBindings,
} from '../native-product-agents.js';

describe('the pinned native product-agent manifest', () => {
  /**
   * The exact bytes, restated. A hash alone would tell somebody that the file
   * changed without telling them what it now says, and the values are what a
   * reviewer has to check against Oxy's pull request.
   */
  it('is exactly what Oxy publishes', () => {
    expect(NATIVE_PRODUCT_AGENT_MANIFEST).toEqual({
      schemaVersion: 1,
      agents: [
        {
          id: '01a0646a-078f-7514-9800-9f43ceed7df8',
          oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
          applicationId: '6a2f851751b784a86fd0e922',
          ownerOxyAccountId: '6a50444ce8026582b949089d',
          product: 'homiio',
          visibility: 'private',
          capabilityGrants: ['web', 'artifacts', 'memory'],
        },
        {
          id: '01a0646a-078f-7642-95ef-439952f4f3f9',
          oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
          applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
          ownerOxyAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
          product: 'clarity',
          visibility: 'private',
          capabilityGrants: [],
        },
      ],
    });
  });

  it('hashes to the hex Oxy asserts against its own source', () => {
    expect(nativeProductAgentManifestSha256()).toBe(NATIVE_PRODUCT_AGENT_MANIFEST_SHA256);
    expect(NATIVE_PRODUCT_AGENT_MANIFEST_SHA256).toBe(
      'a7c1c787c24159ce70e1664ce60749c6a9d3b06a23ff461559b5c97ca2104547',
    );
  });

  /**
   * The hash is over `JSON.stringify`, which preserves INSERTION ORDER. Two
   * manifests with the same fields in a different order hash differently, so
   * the order is part of the contract and not a formatting choice.
   */
  it('hashes over the key order, so a reordered copy is a different manifest', () => {
    const reordered = {
      schemaVersion: 1,
      agents: NATIVE_PRODUCT_AGENT_MANIFEST.agents.map((agent) => ({
        oxyAccountId: agent.oxyAccountId,
        id: agent.id,
        applicationId: agent.applicationId,
        ownerOxyAccountId: agent.ownerOxyAccountId,
        product: agent.product,
        visibility: agent.visibility,
        capabilityGrants: agent.capabilityGrants,
      })),
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(NATIVE_PRODUCT_AGENT_MANIFEST));
  });

  it('binds one bot account to at most one agent', () => {
    const accounts = NATIVE_PRODUCT_AGENT_MANIFEST.agents.map((agent) => agent.oxyAccountId);
    expect(new Set(accounts).size).toBe(accounts.length);
    const ids = NATIVE_PRODUCT_AGENT_MANIFEST.agents.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('publishes every agent as private', () => {
    for (const agent of NATIVE_PRODUCT_AGENT_MANIFEST.agents) {
      expect(agent.visibility).toBe('private');
      expect(agent.applicationId).not.toBe('');
    }
  });

  /**
   * The grants are the one published field this image can MISREAD rather than
   * merely mis-store: the reader drops what it does not recognise, so a family
   * Oxy renamed, or a typo that survived review, becomes a tool set quietly
   * smaller than the one both repositories agreed on, with nothing red.
   *
   * So each published grant is checked against the vocabulary here, where a
   * failure names it, rather than at 3am in a turn that lost `webSearch`.
   */
  it("publishes only grants this image's vocabulary recognises", () => {
    for (const agent of NATIVE_PRODUCT_AGENT_MANIFEST.agents) {
      for (const grant of agent.capabilityGrants) {
        expect(isCapabilityGrant(grant), `${agent.product} publishes "${grant}"`).toBe(true);
      }
      // A duplicate would be harmless to the reader and is still a manifest
      // nobody wrote on purpose, so it is caught where it is cheap.
      expect(new Set(agent.capabilityGrants).size).toBe(agent.capabilityGrants.length);
    }
  });

  /**
   * The exact list, and then the exclusions. `toEqual` alone fails the same way
   * whether a fourth family was added or a name was misspelled; naming the
   * families that must never appear says which failure would matter.
   */
  it('grants Sindi three reading families, and nothing that acts in the world', () => {
    const sindi = findNativeProductAgent('01a0646a-078f-7514-9800-9f43ceed7df8');
    expect(sindi?.capabilityGrants).toEqual(['web', 'artifacts', 'memory']);
    const families = (sindi?.capabilityGrants ?? []).map((grant) => grant.split(':')[0]);
    for (const denied of [
      'shell',
      'browser',
      'files',
      'messaging',
      'automation',
      'delegation',
      'mcp',
      'integration',
      'agent',
      OXY_SERVICE_TOOL_SOURCE,
    ]) {
      expect(families).not.toContain(denied);
    }
  });

  it('grants Clarity nothing, which DENIES rather than leaving it unset', () => {
    expect(findNativeProductAgent('01a0646a-078f-7642-95ef-439952f4f3f9')?.capabilityGrants)
      .toEqual([]);
    // Empty is what an ungranted agent reaches, stated through the reader so
    // this is the vocabulary's answer and not this file's opinion of it.
    expect(readCapabilityGrants([]).allows('web')).toBe(false);
  });

  it('finds an agent by its exact id and nothing near it', () => {
    expect(findNativeProductAgent('01a0646a-078f-7514-9800-9f43ceed7df8')?.product).toBe('homiio');
    expect(findNativeProductAgent('01a0646A-078F-7514-9800-9F43CEED7DF8')).toBeNull();
    expect(findNativeProductAgent('01a0646a-078f-7514-9800-9f43ceed7df')).toBeNull();
  });
});

describe('the workflow bindings', () => {
  it('names every id the workflow restates', () => {
    const names = workflowIdentityBindings().map(([name]) => name);
    expect(names).toEqual([
      'EXPECTED_HOMIIO_AGENT_ID',
      'EXPECTED_HOMIIO_BOT_ID',
      'EXPECTED_HOMIIO_APPLICATION_ID',
      'EXPECTED_HOMIIO_PROJECT_ID',
      'EXPECTED_CLARITY_AGENT_ID',
      'EXPECTED_CLARITY_BOT_ID',
      'EXPECTED_CLARITY_APPLICATION_ID',
      'EXPECTED_CLARITY_PROJECT_ID',
      'EXPECTED_MANIFEST_SHA256',
    ]);
  });

  /**
   * An ABSENT binding is fine and a DISAGREEING one is not. The script runs
   * from a shell as well as from the workflow, so requiring every name would
   * make it unrunnable by hand; what must never happen is a workflow pointed at
   * one application dispatching an image compiled against another.
   */
  it('accepts an environment that says nothing', () => {
    expect(() => assertWorkflowIdentityBindings({})).not.toThrow();
  });

  it('accepts an environment that agrees', () => {
    const env = Object.fromEntries(workflowIdentityBindings());
    expect(() => assertWorkflowIdentityBindings(env)).not.toThrow();
  });

  it('refuses a workflow retargeted at another application', () => {
    expect(() =>
      assertWorkflowIdentityBindings({
        EXPECTED_HOMIIO_APPLICATION_ID: '6a2f851751b784a86fd0e000',
      }),
    ).toThrow(/EXPECTED_HOMIIO_APPLICATION_ID/);
  });

  it('refuses a workflow carrying a stale manifest hash', () => {
    expect(() =>
      assertWorkflowIdentityBindings({ EXPECTED_MANIFEST_SHA256: 'f'.repeat(64) }),
    ).toThrow(/EXPECTED_MANIFEST_SHA256/);
  });
});
