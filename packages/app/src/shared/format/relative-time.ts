/**
 * How long ago, in the shortest form that still says it.
 *
 * Lives here because two different lists want the same words — the memory table
 * and the sidebar's agent rows — and a second copy is how two lists start
 * disagreeing about what "just now" means.
 */
export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
