import { claudeRuntime } from './claude.js';
import { codexRuntime } from './codex.js';
import { opencodeRuntime } from './opencode.js';
import type { ExternalCli, ExternalRuntime } from './types.js';

export function runtimeFor(cli: ExternalCli, command?: string): ExternalRuntime {
  switch (cli) {
    case 'claude':
      return claudeRuntime(command);
    case 'codex':
      return codexRuntime(command);
    case 'opencode':
      return opencodeRuntime(command);
  }
}
