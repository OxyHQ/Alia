export type AutomationExecutionPolicyInput = {
  enabled: boolean;
  executionMode: 'observe' | 'execute';
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  triggerType: 'manual' | 'event' | 'schedule';
};

export function automationExecutionPolicyError(
  policy: AutomationExecutionPolicyInput,
): 'manual_execution_requires_request_autonomy' | 'background_execution_requires_autonomous_policy' | null {
  if (!policy.enabled || policy.executionMode === 'observe') return null;
  if (policy.triggerType === 'manual') {
    return policy.maximumAutonomy === 'execute_on_request' || policy.maximumAutonomy === 'autonomous'
      ? null
      : 'manual_execution_requires_request_autonomy';
  }
  return policy.maximumAutonomy === 'autonomous'
    ? null
    : 'background_execution_requires_autonomous_policy';
}
