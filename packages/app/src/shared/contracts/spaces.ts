/**
 * Spaces (ADR 0028): a folder that groups a person's own agents. The shapes `GET /spaces` serves and
 * `POST`/`PATCH /spaces` accept (`packages/api/src/routes/spaces.ts`, strict bodies).
 */

/** The most agents one space holds (the API's own limit, the room's bound). */
export const SPACE_MAX_AGENTS = 6;
/** A space's name is 1 to this many characters. */
export const SPACE_NAME_MAX = 60;
/** The brief (`instructions`) is at most this many characters. */
export const SPACE_BRIEF_MAX = 4000;

export interface Space {
  id: string;
  name: string;
  /** The brief every member reads; empty when none was written. */
  instructions: string;
  /** The space's room: a group conversation whose members are the space's agents. */
  conversationId: string;
  memberAgentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SpaceCreate {
  name: string;
  instructions?: string;
  agentIds?: string[];
}

export interface SpaceUpdate {
  name?: string;
  instructions?: string;
}

/** The `code` of the API's 409 answers that matter to the sidebar. */
export type SpaceErrorCode = 'space_full' | 'agent_in_other_space';
