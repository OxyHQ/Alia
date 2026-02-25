/**
 * Agent State Machine — With Dynamic Context-Aware Tool Masking
 *
 * Defines the agent lifecycle as a finite state machine with clear transitions.
 * Each state constrains which tool prefixes the model can use (state-based filtering),
 * mirroring Manus's logit-masking approach without modifying the tool set.
 *
 * Enhanced with dynamic masking:
 *   - Remove container tools when no sandbox exists
 *   - Allow plan_* in first iteration even in ACTING state
 *   - Circuit breaker: disable recently-failed tools temporarily
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

/** Tool prefixes that require a sandbox */
const SANDBOX_PREFIXES = ['shell_', 'file_', 'code_', 'port_', 'snapshot_'];

/** Circuit breaker: tool name -> failure timestamps */
interface CircuitBreakerState {
  failures: Map<string, number[]>;
  /** Number of failures before tripping */
  threshold: number;
  /** How long to keep the breaker open (ms) */
  resetMs: number;
}

export interface DynamicMaskingContext {
  /** Whether a sandbox/container is available */
  hasSandbox: boolean;
  /** Current iteration number */
  iteration: number;
}

export class AgentStateMachine {
  private state: AgentState = 'INITIALIZING';
  private history: Array<{ from: AgentState; event: TransitionEvent; to: AgentState; timestamp: number }> = [];
  private circuitBreaker: CircuitBreakerState = {
    failures: new Map(),
    threshold: 3,
    resetMs: 60_000, // 1 minute cooldown
  };

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

  /**
   * Filter a tool set by current state constraints AND dynamic context.
   *
   * Dynamic rules:
   *   1. Remove sandbox tools when no sandbox available
   *   2. Allow plan_* in first iteration even during ACTING (so agent can plan)
   *   3. Circuit breaker: temporarily disable tools that keep failing
   */
  filterTools<T>(tools: Record<string, T>, context?: DynamicMaskingContext): Record<string, T> {
    const prefixes = this.getAllowedToolPrefixes();

    // Terminal states = no tools
    if (prefixes !== null && prefixes.length === 0) return {};

    let filtered: Record<string, T>;

    if (prefixes === null) {
      // All tools allowed (ACTING state) — start with full set
      filtered = { ...tools };
    } else {
      // Filter by prefix
      filtered = {};
      for (const [name, tool] of Object.entries(tools)) {
        if (prefixes.some(prefix => name.startsWith(prefix))) {
          filtered[name] = tool;
        }
      }
    }

    // ── Dynamic masking ──

    if (context) {
      // 1. Remove sandbox tools if no sandbox available
      if (!context.hasSandbox) {
        for (const name of Object.keys(filtered)) {
          if (SANDBOX_PREFIXES.some(prefix => name.startsWith(prefix))) {
            // Keep shell_create_container — that's how you GET a sandbox
            if (name !== 'shell_create_container') {
              delete filtered[name];
            }
          }
        }
      }

      // 2. Allow plan_* in first iteration even in ACTING state
      if (context.iteration === 0 && this.state === 'ACTING') {
        for (const [name, tool] of Object.entries(tools)) {
          if (name.startsWith('plan_')) {
            filtered[name] = tool;
          }
        }
      }
    }

    // 3. Circuit breaker: remove tools that have failed too many times recently
    const now = Date.now();
    for (const name of Object.keys(filtered)) {
      const failures = this.circuitBreaker.failures.get(name);
      if (!failures) continue;

      // Prune old failures
      const recent = failures.filter(t => now - t < this.circuitBreaker.resetMs);
      if (recent.length !== failures.length) {
        this.circuitBreaker.failures.set(name, recent);
      }

      if (recent.length >= this.circuitBreaker.threshold) {
        delete filtered[name];
      }
    }

    return filtered;
  }

  /**
   * Record a tool failure for the circuit breaker.
   */
  recordToolFailure(toolName: string): void {
    if (!this.circuitBreaker.failures.has(toolName)) {
      this.circuitBreaker.failures.set(toolName, []);
    }
    this.circuitBreaker.failures.get(toolName)!.push(Date.now());
  }

  /**
   * Reset circuit breaker for a tool (e.g. after a successful call).
   */
  resetToolCircuit(toolName: string): void {
    this.circuitBreaker.failures.delete(toolName);
  }

  /** Get transition history */
  getHistory() {
    return this.history;
  }
}
