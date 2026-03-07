function envFlag(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const autonomyFlags = {
  runtimeEnabled: envFlag('AUTONOMY_RUNTIME_ENABLED', true),
  contextGraphEnabled: envFlag('AUTONOMY_CONTEXT_GRAPH_ENABLED', true),
  approvalsEnabled: envFlag('AUTONOMY_APPROVALS_ENABLED', true),
  rollbackEnabled: envFlag('AUTONOMY_ROLLBACK_ENABLED', true),
  oxyAutonomousEnabled: envFlag('AUTONOMY_OXY_EVENTS_ENABLED', true),
};
