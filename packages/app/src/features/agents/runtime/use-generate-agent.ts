import {
  applyBotUsernameSuffix,
  createBotAccount,
} from '@/features/agents/model/bot-account';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { useCreateAgent } from '@/features/agents/runtime/use-agents';
import type { Agent, AgentArchetype } from '@/shared/contracts/agents';
import {
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
import { useCallback } from 'react';

/** Whether a value IS one of Oxy's offered categories. See the note at the call site. */
function isOfferedAccountCategory(value: unknown): value is AccountCategoryId {
  return typeof value === 'string'
    && (SELECTABLE_ACCOUNT_CATEGORY_IDS as readonly string[]).includes(value);
}

export interface GeneratedAgent {
  agent: Agent;
  /**
   * The handle Oxy granted when it is NOT the one proposed, or null when the
   * proposal was taken as is. See the note where it is computed.
   */
  adjustedHandle: string | null;
}

/**
 * An agent, from a sentence: generate its configuration, mint its identity at
 * Oxy, then create its runtime bound to that identity — three writes, in that
 * order, each needing the one before.
 *
 * A failure at any step rejects with that step's error; the screen says it.
 */
export function useGenerateAgent() {
  const createAgent = useCreateAgent();
  const { createAccount, oxyServices } = useOxy();

  return useCallback(async (
    prompt: string,
    archetype: AgentArchetype,
  ): Promise<GeneratedAgent> => {
    // Step 1: AI generates agent config from prompt. `suggestedUsername` is a
    // PROPOSAL — Oxy owns the handle namespace and resolves collisions.
    const genRes = await apiClient.post(API_ROUTES.agents.generate, {
      prompt,
    });
    const config = genRes.data;

    /**
     * Step 2: mint the agent's IDENTITY at Oxy — a `bot` account under the
     * signed-in person's own tree, which makes them its owner.
     *
     * This is where the agent's name and handle now live. Alia never sees
     * them again except by reading them back.
     *
     * There is no avatar step. An agent's likeness is the `IdentityMark`
     * Alia herself wears, drawn in the account's own `User.color` — a field
     * `createAccount` cannot carry, so a new agent starts out drawn in the
     * theme's color and stays that way until Oxy can set one.
     */
    const account = await createBotAccount({
      createAccount,
      username: config.suggestedUsername,
      /**
       * Ask before minting, so a taken suggestion becomes a free handle the
       * person is TOLD about below — rather than the silent rename they used
       * to discover afterwards, when `community-maestro` had quietly become
       * `community-maestro1`.
       */
      checkAvailability: async (candidate) =>
        (await oxyServices.checkUsernameAvailability(candidate)).available,
      displayName: config.name,
      bio: config.tagline,
      /**
       * Only when the taxonomy recognises it. The generate route validated
       * this already, and it is checked again here for a reason that is not
       * distrust: `genRes.data` is `any`, so without a narrowing the union
       * `CreateAccountInput` declares would be satisfied by a claim rather
       * than by a check.
       *
       * MEMBERSHIP, not `isSelectableAccountCategoryId` — that one asks "is
       * this id still offered" against a retired list that is empty today, so
       * it answers true for anything at all, `undefined` included.
       *
       * Nothing fitting is a valid agent, so absent travels as absent. An
       * empty array would mean "clear them", which is a different request.
       */
      ...(isOfferedAccountCategory(config.accountCategory)
        ? { accountCategories: [config.accountCategory] }
        : {}),
      // This screen builds a DRAFT (`isPublished: false` below), so the
      // account is minted undiscoverable to match: kept out of Oxy's global
      // people search from the moment it exists, rather than listed there
      // under its owner's name until they publish it.
      private: true,
    });

    // Step 3: create the RUNTIME, bound to that account.
    const agent = await createAgent.mutateAsync({
      oxyAccountId: account.accountId,
      tagline: config.tagline,
      description: config.description,
      category: config.category,
      tags: config.tags,
      capabilityGrants: config.capabilityGrants,
      systemPrompt: config.systemPrompt,
      isPublished: false,
      archetype: config.archetype || archetype,
    });

    /**
     * Which handle it got, and only when it is not the one proposed.
     *
     * Against the LABELLED suggestion, because a bot's handle ends in `bot`
     * and that label is added at the mint. Comparing against the bare
     * suggestion would announce an adjustment on every single create, which
     * is how a message that means something becomes one nobody reads.
     */
    const granted = account.account.username;
    const adjustedHandle =
      granted !== undefined && granted !== applyBotUsernameSuffix(config.suggestedUsername)
        ? granted
        : null;
    return { agent, adjustedHandle };
  }, [createAgent.mutateAsync, createAccount, oxyServices]);
}
