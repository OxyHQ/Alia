/**
 * CodeAct Executor — Execute Agent-Generated Code in Sandboxed Containers
 *
 * Implements the CodeAct pattern (ICML 2024): agents write executable Python
 * code as their "action" instead of fixed tool calls. This enables:
 *   - Compositional reasoning (chain operations, conditionals, error handling)
 *   - Access to the full Python ecosystem (libraries, data processing)
 *   - 20% higher success rate vs JSON tool calls (per Manus benchmarks)
 *
 * Flow: Agent generates Python → safety check → write to workspace → execute → capture output
 */

import { getSandboxProvider } from '../../sandbox/index.js';
import { log } from '../../logger.js';
import { getErrorMessage } from '../../errors/index.js';
import { checkCodeSafety, MAX_CODE_LENGTH, DEFAULT_EXEC_TIMEOUT } from './codeact-sandbox.js';

export interface CodeActResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  filePath: string;
  executionTimeMs: number;
  safetyWarnings: string[];
}

export interface CodeActOptions {
  /** Container ID to execute in */
  containerId: string;
  /** Python code to execute */
  code: string;
  /** Description of what the code does (for logging/audit) */
  description: string;
  /** Sequence number for file naming */
  seq: number;
  /** Execution timeout in milliseconds (default: 60s) */
  timeout?: number;
}

/**
 * Execute Python code in a container sandbox.
 *
 * 1. Validates code against safety rules
 * 2. Writes code to /workspace/.alia/scripts/{seq}.py
 * 3. Executes with timeout
 * 4. Captures stdout/stderr and exit code
 */
export async function executeCode(opts: CodeActOptions): Promise<CodeActResult> {
  const { containerId, code, description, seq, timeout = DEFAULT_EXEC_TIMEOUT } = opts;
  const startMs = Date.now();
  const filePath = `/workspace/.alia/scripts/${seq}.py`;

  // ── 1. Code length check ──
  if (code.length > MAX_CODE_LENGTH) {
    return {
      success: false,
      stdout: '',
      stderr: `Code exceeds maximum length of ${MAX_CODE_LENGTH} characters (got ${code.length})`,
      exitCode: 1,
      filePath,
      executionTimeMs: 0,
      safetyWarnings: [],
    };
  }

  // ── 2. Safety analysis ──
  const safetyCheck = checkCodeSafety(code);
  if (!safetyCheck.safe) {
    return {
      success: false,
      stdout: '',
      stderr: `Code blocked by safety check:\n${safetyCheck.violations.map(v => `- ${v}`).join('\n')}`,
      exitCode: 1,
      filePath,
      executionTimeMs: 0,
      safetyWarnings: safetyCheck.warnings,
    };
  }

  log.agents.info({ containerId, seq, description, codeLength: code.length, warnings: safetyCheck.warnings }, 'CodeAct: executing');

  const sandbox = getSandboxProvider();

  // ── 3. Ensure scripts directory exists ──
  try {
    await sandbox.exec(containerId, 'mkdir -p /workspace/.alia/scripts', 5);
  } catch {
    // Directory may already exist
  }

  // ── 4. Write code to file ──
  try {
    await sandbox.writeFile(containerId, filePath, code);
  } catch (err: unknown) {
    return {
      success: false,
      stdout: '',
      stderr: `Failed to write script: ${getErrorMessage(err)}`,
      exitCode: 1,
      filePath,
      executionTimeMs: Date.now() - startMs,
      safetyWarnings: safetyCheck.warnings,
    };
  }

  // ── 5. Execute with timeout ──
  try {
    const timeoutSec = Math.ceil(timeout / 1000);
    const result = await sandbox.exec(
      containerId,
      `cd /workspace && python3 ${filePath} 2>&1`,
      timeoutSec,
    );

    const executionTimeMs = Date.now() - startMs;
    const exitCode = result.exitCode ?? 0;
    const output = result.stdout || result.stderr || '';

    log.agents.info({ containerId, seq, exitCode, executionTimeMs, outputLength: output.length }, 'CodeAct: completed');

    return {
      success: exitCode === 0,
      stdout: exitCode === 0 ? output : '',
      stderr: exitCode !== 0 ? output : '',
      exitCode,
      filePath,
      executionTimeMs,
      safetyWarnings: safetyCheck.warnings,
    };
  } catch (err: unknown) {
    const executionTimeMs = Date.now() - startMs;
    const errMsg = getErrorMessage(err);
    const isTimeout = errMsg.includes('timeout') || executionTimeMs >= timeout;

    log.agents.error({ containerId, seq, err: errMsg, executionTimeMs }, 'CodeAct: execution error');

    return {
      success: false,
      stdout: '',
      stderr: isTimeout
        ? `Execution timed out after ${Math.round(timeout / 1000)}s. Consider breaking the task into smaller steps.`
        : `Execution error: ${errMsg}`,
      exitCode: isTimeout ? 124 : 1,
      filePath,
      executionTimeMs,
      safetyWarnings: safetyCheck.warnings,
    };
  }
}
