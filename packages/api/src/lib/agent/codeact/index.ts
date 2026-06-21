/**
 * CodeAct Module — Code-as-Action for Agent Execution
 *
 * Provides the `code_execute` tool that allows agents to write and execute
 * Python code as their primary action mechanism (Manus CodeAct pattern).
 */

export { executeCode, type CodeActResult, type CodeActOptions } from './codeact-executor.js';
export { checkCodeSafety, MAX_CODE_LENGTH, DEFAULT_EXEC_TIMEOUT, type SandboxCheckResult } from './codeact-sandbox.js';
