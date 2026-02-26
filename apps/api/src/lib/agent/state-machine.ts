/**
 * Agent State Machine — v2: State Instructions (Manus KV-Cache Pattern)
 *
 * Instead of removing tools from context (which invalidates KV-cache),
 * we keep ALL tool definitions stable across iterations and inject
 * state instructions into the context tail. The model naturally
 * respects these instructions.
 *
 * This preserves the tenfold cost difference between cached ($0.30/MTok)
 * and uncached ($3/MTok) Claude tokens.
 *
 * States: INITIALIZING → PLANNING → ACTING → OBSERVING → REFLECTING → COMPLETED
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
  | 'initialized'
  | 'plan_created'
  | 'action_taken'
  | 'observation_received'
  | 'needs_replan'
  | 'continue'
  | 'task_completed'
  | 'error'
  | 'cancelled'
  | 'budget_exceeded';

const TRANSITIONS: Record<AgentState, Partial<Record<TransitionEvent, AgentState>>> = {
  INITIALIZING: {
    initialized: 'PLANNING',
    error: 'FAILED',
    cancelled: 'CANCELLED',
  },
  PLANNING: {
    plan_created: 'ACTING',
    action_taken: 'OBSERVING',
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
 * State instructions — injected into context tail instead of filtering tools.
 * All actions remain in context for KV-cache stability.
 */
const STATE_INSTRUCTIONS: Record<AgentState, string> = {
  INITIALIZING: '',
  PLANNING: 'You are in PLANNING state. Create a plan using the plan action before taking other actions.',
  ACTING: '', // All actions available, no restrictions
  OBSERVING: '', // Passive state — no instruction needed
  REFLECTING: `Review the result of your last action. If it failed, analyze WHY it failed:
1. Is there a different tool or approach that could achieve the same goal?
2. Is the task specification ambiguous — can you reframe it?
3. Can you break this step into smaller sub-steps?
4. Should you skip this step and move on to the next one?
Update your plan with the new approach, then continue.`,
  COMPLETED: '',
  FAILED: '',
  CANCELLED: '',
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
   * Get state instruction text to inject at context tail.
   * Returns empty string if no instruction needed (e.g., ACTING state).
   * This replaces the old filterTools() approach — tools stay stable in context.
   */
  getStateInstruction(): string {
    return STATE_INSTRUCTIONS[this.state];
  }

  /**
   * Legacy: Filter tools by state (kept for backward compat with old agent-runner).
   * New runner uses getStateInstruction() instead.
   */
  filterTools<T>(tools: Record<string, T>): Record<string, T> {
    return { ...tools };
  }

  /** Get transition history */
  getHistory() {
    return this.history;
  }
}
