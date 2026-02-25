/**
 * Agent State Machine
 *
 * Defines the agent lifecycle as a finite state machine with clear transitions.
 * Each state constrains which tool prefixes the model can use (state-based filtering),
 * mirroring Manus's logit-masking approach without modifying the tool set.
 */

export type AgentState =
  | 'INITIALIZING'
  | 'PLANNING'
  | 'ACTING'
  | 'OBSERVING'
  | 'REFLECTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type TransitionEvent =
  | 'initialized'       // Tools built, session ready
  | 'plan_created'      // Agent created/updated plan, ready to act
  | 'action_taken'      // Agent called a tool
  | 'observation_received'  // Tool result received
  | 'needs_replan'      // Agent needs to reconsider the plan
  | 'continue'          // Continue with next action
  | 'task_completed'    // Agent signaled completion
  | 'error'             // Unrecoverable error
  | 'cancelled'         // User cancelled
  | 'budget_exceeded';  // Step or token limit hit

const TRANSITIONS: Record<AgentState, Partial<Record<TransitionEvent, AgentState>>> = {
  INITIALIZING: {
    initialized: 'PLANNING',
    error: 'FAILED',
    cancelled: 'CANCELLED',
  },
  PLANNING: {
    plan_created: 'ACTING',
    action_taken: 'OBSERVING', // Agent may skip explicit planning and just act
    task_completed: 'COMPLETED',
    error: 'FAILED',
    cancelled: 'CANCELLED',
    budget_exceeded: 'COMPLETED',
  },
  ACTING: {
    action_taken: 'OBSERVING',
    task_completed: 'COMPLETED',
    error: 'FAILED',
    cancelled: 'CANCELLED',
    budget_exceeded: 'COMPLETED',
  },
  OBSERVING: {
    observation_received: 'REFLECTING',
    error: 'FAILED',
    cancelled: 'CANCELLED',
  },
  REFLECTING: {
    needs_replan: 'PLANNING',
    continue: 'ACTING',
    plan_created: 'ACTING',
    action_taken: 'OBSERVING',
    task_completed: 'COMPLETED',
    error: 'FAILED',
    cancelled: 'CANCELLED',
    budget_exceeded: 'COMPLETED',
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

/**
 * Tool prefix allowlists per state.
 * In ACTING state, all prefixes are allowed (null = no filtering).
 * In other states, only specific prefixes are permitted.
 */
const STATE_TOOL_PREFIXES: Record<AgentState, string[] | null> = {
  INITIALIZING: [],       // No tools during init
  PLANNING: ['plan_'],    // Only planning tools
  ACTING: null,           // All tools allowed
  OBSERVING: [],          // No tools while observing (passive state)
  REFLECTING: ['plan_', 'agent_'], // Planning + delegation
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class AgentStateMachine {
  private state: AgentState = 'INITIALIZING';
  private history: Array<{ from: AgentState; event: TransitionEvent; to: AgentState; timestamp: number }> = [];

  constructor(initialState?: AgentState) {
    if (initialState) this.state = initialState;
  }

  /** Current state */
  current(): AgentState {
    return this.state;
  }

  /** Whether the machine is in a terminal state */
  isTerminal(): boolean {
    return this.state === 'COMPLETED' || this.state === 'FAILED' || this.state === 'CANCELLED';
  }

  /** Attempt a transition. Returns the new state, or throws if invalid. */
  transition(event: TransitionEvent): AgentState {
    const validTransitions = TRANSITIONS[this.state];
    const nextState = validTransitions[event];

    if (!nextState) {
      throw new Error(
        `Invalid transition: ${this.state} --[${event}]--> ? (valid events: ${Object.keys(validTransitions).join(', ')})`,
      );
    }

    this.history.push({
      from: this.state,
      event,
      to: nextState,
      timestamp: Date.now(),
    });

    this.state = nextState;
    return nextState;
  }

  /** Check if a transition would be valid without performing it */
  canTransition(event: TransitionEvent): boolean {
    return Boolean(TRANSITIONS[this.state][event]);
  }

  /**
   * Get allowed tool prefixes for the current state.
   * Returns null if all tools are allowed (ACTING state).
   * Returns string[] of allowed prefixes otherwise.
   */
  getAllowedToolPrefixes(): string[] | null {
    return STATE_TOOL_PREFIXES[this.state];
  }

  /** Filter a tool set by current state constraints */
  filterTools<T>(tools: Record<string, T>): Record<string, T> {
    const prefixes = this.getAllowedToolPrefixes();

    // null = all tools allowed
    if (prefixes === null) return tools;

    // Empty = no tools
    if (prefixes.length === 0) return {};

    const filtered: Record<string, T> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (prefixes.some(prefix => name.startsWith(prefix))) {
        filtered[name] = tool;
      }
    }
    return filtered;
  }

  /** Get transition history */
  getHistory() {
    return this.history;
  }
}
