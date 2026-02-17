export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
export type ToolCategory = 'read_only' | 'file_write' | 'shell';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  read_file: 'read_only',
  list_files: 'read_only',
  search_files: 'read_only',
  write_file: 'file_write',
  edit_file: 'file_write',
  apply_patch: 'file_write',
  run_command: 'shell',
};

export function categorize(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] || 'shell';
}

export function needsApproval(toolName: string, mode: ApprovalMode): boolean {
  const category = categorize(toolName);

  switch (mode) {
    case 'full-auto':
      return false;
    case 'auto-edit':
      return category === 'shell';
    case 'suggest':
      return category === 'file_write' || category === 'shell';
    default:
      return true;
  }
}
