export function formatToolArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path ?? '');
    case 'apply_patch':
      return 'applying patch…';
    case 'list_files':
      return String(args.path ?? '.');
    case 'search_files':
      return `"${args.pattern}" in ${args.path ?? '.'}`;
    case 'run_command':
      return String(args.command ?? '');
    default:
      return JSON.stringify(args).slice(0, 60);
  }
}

export function formatApprovalDescription(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'write_file':
      return `Write to ${args.path}`;
    case 'edit_file':
      return `Edit ${args.path}`;
    case 'apply_patch':
      return 'Apply patch';
    case 'run_command':
      return `Run: ${args.command}`;
    default:
      return `${tool}: ${JSON.stringify(args).slice(0, 80)}`;
  }
}
