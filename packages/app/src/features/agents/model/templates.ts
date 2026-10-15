/** Editable starting instructions, never an authority manifest. Grants are chosen separately. */
export const AGENT_TEMPLATE_IDS = ['communication', 'materials'] as const;
export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];
export function templateCopyKey(
  id: AgentTemplateId,
  field: 'label' | 'description' | 'prompt' | 'access',
) {
  return `agents.templates.${id}.${field}`;
}
