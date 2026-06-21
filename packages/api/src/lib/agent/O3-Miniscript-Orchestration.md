# O3-Miniscript Orchestration — Agent Coordination Architecture

> **Status:** Production — Three-layer Manus pattern fully operational since v0.4.0
> **Coverage:** 4 files | 1200+ lines of coordinated orchestration code
> **Pattern:** Planner → Execute (parallel) → Verify with retry

---

## 📖 Executive Summary

Alia uses a three-layer orchestration pattern inspired by the Manus AI project to coordinate multiple agents. When complex tasks are detected, the orchestrator activates a team of agents working in parallel, all supervised by the main agent.

**The flow:**
1. **Planner** decomposes the complex task into subtasks with dependencies
2. **Executor pool** runs subtasks in parallel, respecting dependencies and concurrency limits
3. **Verifier** confirms results meet requirements, triggering retry on failure

This enables Alia to handle complex multi-step tasks (research, coding, implementation) by splitting work across specialized agents while maintaining full supervision.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Alia Agent Loop                           │
│  (handles single tasks, simple reasoning, tool use)              │
└──────────────────────────────────────────────────────────────────┘

                    ↓ Complex task detected (>1 subtask expected)
                    ↓

┌──────────────────────────────────────────────────────────────────┐
│                    Three-Layer Orchestration                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────┐         ┌──────────────────────────────────┐   │
│  │   Planner   │         │  Executor Pool                   │   │
│  │ (thinking   │   ───►  │  Runs subtasks in parallel,      │   │
│  │   model)    │         │  respects dependencies &         │   │
│  └─────────────┘         │  concurrency limits               │   │
│                          └──────────────────────────────────┘   │
│              ┌──────────────────────────────────┐              │
│              │         Verifier                  │              │
│              │  (cheap model, quality check)     │              │
│              └──────────────────────────────────┘              │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────┐
│                    Synthesize Final Result                        │
│  (merge multiple executor outputs into coherent response)         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📂 File Inventory

### Core Orchestration

| File | Lines | Responsibility |
|------|-------|----------------|
| `orchestrator.ts` | 287 | Coordinates the full pipeline with retry logic |
| `planner-agent.ts` | 131 | Decomposes tasks into subtask plans |
| `executor-pool.ts` | 209 | Manages parallel subtask execution |
| `verifier-agent.ts` | 120 | Quality checks and scoring |

---

## 🔄 Orchestration Flow

### Decision Gate: Should We Orchestrate?

The orchestrator activates only when `shouldOrchestrate` returns `true`. This heuristic checks:

**Multi-part indicators:**
- "and then", "after that", "next", "finally"
- Numbered lists ("first...", "second...")
- "multiple files", "several APIs"
- "compare X with Y"

**Complexity indicators:**
- "research", "investigate", "analyze"
- "implement ... system", "build ... architecture"
- "migrate", "refactor", "overhaul"

**Also checks:**
- Task length > 50 chars
- Delegation depth < MAX_DELEGATION_DEPTH

### Step-by-Step Pipeline

**1. Plan (Planner)**
```typescript
const plan = await generatePlan(task, {
  agentName,
  availableAgents,
  maxSubtasks: min(maxSteps / 5, 10),
});
```

The planner generates an `ExecutionPlan` object with:
- `subtasks`: Ordered array of decomposition (1-20 items)
- `parallelGroups`: Sets of IDs that can run simultaneously
- `dependsOn`: Dependency graph for each subtask
- `complexity`: 'light'/'medium'/'heavy' for cost optimization
- `strategy`: Overall approach description
- `analysis`: Requirement breakdown

**2. Execute (Executor Pool)**
```typescript
const executorResults = await executeSubtasks(plan.subtasks, {
  maxConcurrency,                 // Default: 3
  maxStepsPerExecutor,           // Split budget among subtasks
  maxTokensPerExecutor,
  timeoutMs,
  parentSession,
});
```

The executor:
- Processes subtasks using a topological dependency order
- Launches up to `maxConcurrency` tasks in parallel
- For each subtask:
  - Looks up specialized agent by `agentHandle` if specified
  - Adjusts limits based on complexity multiplier (light=0.3x, medium=0.6x, heavy=1x)
  - Creates an `AgentSession` and runs it
  - Applies timeout; marks as cancelled on expiry
  - Captures result on success or error message on failure

**3. Verify (Verifier)**
```typescript
const verification = await verifyResults(originalTask, executorResults);
```

The verifier:
- Runs on a cost-efficient model (alia-lite or alia-v1)
- Evaluates four criteria:
  - Completeness: All aspects addressed?
  - Correctness: Results accurate and reasonable?
  - Consistency: Results align across subtasks?
  - Quality: Output useful and well-formed?
- Returns score 0-10; task passes if ≥ minScore (default 6)
- On failure, returns specific issues and suggestions

**4. Retry (Optional)**
If verification fails and retries allowed:
- Collect failed subtasks
- Append verifier feedback to their descriptions
- Re-execute failed subtasks only
- Re-verify

**5. Synthesize**
```typescript
const finalResult = await synthesizeResult(task, executorResults);
```

Merges all successful executor results into a coherent, unified response:
- Single result: return as-is
- Multiple results: use model to synthesize a unified answer
- Fallback: concatenate with separators

---

## 📊 Data Contracts

### Subtask

```typescript
export interface Subtask {
  id: number;                      // Unique executor ID
  description: string;             // Task for the executor
  dependsOn: number[];             // Predecessor subtask IDs
  complexity: 'light' | 'medium' | 'heavy';  // Cost tier
  agentHandle?: string;            // Optional specialist handle (e.g., "@python")
}
```

### ExecutionPlan

```typescript
export interface ExecutionPlan {
  analysis: string;                // High-level requirement breakdown
  subtasks: Subtask[];             // 1-20 subtasks
  parallelGroups: number[][];      // Can run [1,2] concurrently with [3,4]
  strategy: string;                // Overall execution approach
}
```

### ExecutorResult

```typescript
export interface ExecutorResult {
  subtaskId: number;               // Original subtask ID
  subtask: string;                 // Description (for logging)
  result: string;                  // Executor output or failure message
  success: boolean;                // True if completed without error
  sessionId: string;               // Agent session ID
  durationMs: number;              // Execution time
}
```

### VerificationResult

```typescript
export interface VerificationResult {
  passed: boolean;                 // Did we meet requirements?
  score: number;                   // 0-10 quality score
  issues: string[];                // Specific problems found
  suggestions: string[];           // How to improve
  summary: string;                 // Brief evaluation
}
```

---

## 🔍 Deep Dive: Each Layer

### Planner: Task Decomposition

**Purpose:** Use a capable thinking model to break a complex task into executable pieces.

**Model selection:**
1. Tries `alia-v1-thinking` (preferred for planning)
2. Falls back to `alia-v1-pro` or `alia-v1`
3. Last resort: default model

**System prompt rules:**
- Keep subtasks atomic and independently executable
- Identify parallelism opportunities (no dependency between tasks)
- Mark complexity for cost optimization
- Reference subtask IDs for dependencies

**Fallback:** If planning fails, treat entire task as a single subtask with "heavy" complexity.

### Executor Pool: Parallel Execution

**Purpose:** Run subtasks respecting concurrency and dependency constraints.

**Algorithm:**
1. Find subtasks whose dependencies are satisfied
2. Launch up to `maxConcurrency` tasks
3. Wait for one to complete (always pick first to finish)
4. Repeat until all done
5. On deadlock: force all remaining tasks to run

**Per-subtask setup:**
- Look up specialized agent if `agentHandle` specified
- Adjust limits by complexity multiplier
- Create session with incremented depth
- Apply timeout; cancel on expiry

**Context chaining:** Dependency results appended to subtask before execution.

### Verifier: Quality Assurance

**Purpose:** Use a cost-efficient model to check if output meets requirements.

**Evaluation criteria:**
1. Completeness: All aspects addressed?
2. Correctness: Are results accurate?
3. Consistency: Do results align?
4. Quality: Is output useful?

**Fallback behavior:**
- No model available: auto-pass with score 5
- Verification model fails: pass if ≥50% executors succeeded

**Retry feedback:** Appends verifier suggestions to failed subtasks.

### Synthesizer: Result Merging

**Purpose:** Combine multiple executor outputs into one coherent response.

**Logic:**
- Zero success: return "All subtasks failed"
- One success: return that result
- Multiple successes: generate text synthesis or concatenate

---

## 🎯 Heuristics

### Should Orchestrate?

```typescript
export function shouldOrchestrate(task: string, depth: number): boolean {
  // Depth check
  if (depth >= MAX_DELEGATION_DEPTH - 1) return false;
  
  // Short tasks skipped
  if (task.length < 50) return false;
  
  // Multi-part detection
  const multiPartScore = [
    /and then|after that|next|finally|also/i,
    /first|second|third|step \d|phase \d/i,
    /\d+\. /,
    /multiple|several|various.*files?|repos?|APIs?/i,
    /compare|contrast.*and|vs\/with/i,
  ].filter(r => r.test(task)).length;
  
  // Complexity detection
  const complexScore = [
    /research|investigate|analyze|audit/i,
    /implement.*build.*design.*system|architecture|module/i,
    /migrate|refactor|overhaul/i,
  ].filter(r => r.test(task)).length;
  
  // Trigger if multi-part enough or mixed signal
  return multiPartScore >= 2 || (multiPartScore >= 1 && complexScore >= 1);
}
```

### Complexity Multipliers

Used to scale resource budgets per subtask:

| Complexity | Multiplier | Max Steps | Max Tokens |
|------------|------------|-----------|------------|
| light      | 0.3        | 30%       | 1500       |
| medium     | 0.6        | 60%       | 3000       |
| heavy      | 1.0        | 100%      | full       |

---

## 🧩 Failure Handling

### Planner Failure
- Returns fallback plan: single subtask with original task text
- Logs error but doesn't throw
- Executor runs it directly (may fail too)

### Executor Failure
- Each subtask returns `success: false` with error message
- Verifier reduces score based on failure rate
- Retry phase specifically re-executes failed subtasks

### Verifier Failure
- Falls back to success-rate scoring
- Auto-passes if ≥50% executors succeeded
- Logs error but continues

### Timeout
- Executor session marked as "cancelled" in MongoDB
- Session runner detects cancellation and stops

### Depth Limit
- `MAX_DELEGATION_DEPTH` (typically 3) prevents infinite nesting
- At max depth, orchestrator returns error and caller handles task

---

## 📈 Performance Characteristics

### Concurrency Control
- Default: 3 parallel executors
- Adjustable via `maxConcurrency` option
- Prevents resource exhaustion from too many simultaneous calls

### Cost Optimization
- Planner: capable model (necessary for good decomposition)
- Executors: scale by complexity (light tasks use cheap models)
- Verifier: cheap model (cost-efficient QA)
- Synthesizer: optional (uses model only when merging multiple results)

### Time Complexity
- **Planner:** O(1) model call
- **Executors:** parallel execution, wall-clock time = longest path in dependency graph
- **Verifier:** O(1) model call
- **Retry:** additional executor cycles for failed subtasks
- **Synthesizer:** optional model call

---

## 🔧 Integration Points

### OrchestrationOptions

```typescript
export interface OrchestrationOptions {
  task: string;              // Original user request
  session: {                 // Parent session for context
    _id: any;
    userId: any;
    agentId: any;
    depth: number;           // Delegation depth
    config: { maxSteps, maxTokens, maxVMs };
  };
  agent?: {                  // Agent context
    name?: string;
    description?: string;
  };
  eventStream: EventStream;  // For logging progress
  maxConcurrency?: number;   // Parallel limit (default 3)
  maxRetries?: number;       // Retry count on verification fail (default 1)
}
```

### OrchestrationResult

```typescript
export interface OrchestrationResult {
  success: boolean;          // Verification passed?
  result: string;            // Concatenated final result
  plan: ExecutionPlan;       // Generated execution plan
  executorResults: ExecutorResult[];  // All subtask outputs
  verification: VerificationResult | null;  // Final verification
  totalDurationMs: number;   // Total pipeline time
}
```

### Event Stream

The orchestrator appends events for observers:
- `system_message`: pipeline stage transitions
- `thinking`: decomposing, verifying
- `plan_update`: plan details (strategy, subtasks)
- `observation`: successful executor completion, verifier pass
- `error`: failed executor, verifier fail issues
- `complete`: pipeline finished

---

## ⚙️ Configuration

### Default Values

| Setting | Default | Description |
|---------|---------|-------------|
| maxConcurrency | 3 | Parallel executors |
| maxRetries | 1 | Retry on verification fail |
| minScore | 6 | Pass threshold out of 10 |
| maxSubtasks | min(maxSteps/5, 10) | Planner limit |

### Executor Budgets

Calculated from parent session:

```typescript
maxStepsPerExecutor = max(5, floor(parent.maxSteps / subtaskCount))
maxTokensPerExecutor = max(5000, floor(parent.maxTokens / subtaskCount))
timeoutMs = max(30000, floor(300000 / subtaskCount) * subtaskCount)
```

This scales resources inversely with subtask count, ensuring budget conservation.

---

## 🔄 Retry Logic

When verification fails:

1. Collect all failed subtasks
2. Remove dependencies (for retry flexibility)
3. Append verifier suggestions to descriptions
4. Re-execute failed subtasks
5. Re-verify entire set

Retry only happens if `maxRetries > 0`. By default, single retry allowed.

---

## 🔍 Logging

All components log to `logger.agents`:

**Planner:**
- Info: subtask count, parallel groups
- Error: planning exception

**Executor:**
- Info: subtask start, completion (ID, result, duration)
- Warn: deadlock recovery

**Verifier:**
- Info: pass/fail, score, issue count
- Error: verification exception

**Orchestrator:**
- Info: depth check, plan details, verification result
- Error: execution/verification failures

All logs include context for debugging and observability.

---

## 🎯 Best Practices

### When to Use Orchestration
✅ **Complex tasks** that clearly benefit from decomposition:
- "Research X, then Y, finally Z"
- "Analyze A, B, C and compare"
- "First build backend, then frontend, finally deploy"

### When to Skip Orchestration
❌ Simple tasks:
- "Summarize this article" → single agent loop
- "Fix this bug" → single agent loop
- "Write a poem" → single agent loop

### Specialist Agents
Use `agentHandle` to route subtasks to specialists:

```typescript
{
  id: 2,
  description: "Implement search algorithm in Python",
  agentHandle: "@python",  // Routes to Python specialist
  dependsOn: [1],
  complexity: "heavy"
}
```

### Complexity Marking
Mark subtasks accurately:
- **light**: Simple lookups, basic CRUD
- **medium**: Standard reasoning, API calls
- **heavy**: Complex analysis, code generation, research

---

## 🧪 Testing

Each layer has unit tests:

- `planner-agent.test.ts`: Test plan generation with various tasks
- `executor-pool.test.ts`: Test dependency resolution, parallelism
- `verifier-agent.test.ts`: Test scoring, feedback generation
- `orchestrator.test.ts`: Test full pipeline, retry logic

Integration tests verify the full Manus pattern end-to-end.

---

## 📜 License

MIT © Alia Labs
