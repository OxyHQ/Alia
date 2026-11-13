import * as Skeleton from '@oxy.so/bloom/skeleton';

const WIDTHS = ['72%', '88%', '54%', '80%', '63%', '91%', '46%', '76%'] as const;

/**
 * Lines of text that are on their way, for a panel whose content is a document or a console (the
 * agent's terminal while it connects, a file while it is read): uneven, so they read as text.
 */
export function LinesSkeleton({ lines = 8, className }: { lines?: number; className?: string }) {
  return (
    <Skeleton.Region className={`gap-2.5 p-3 ${className ?? ''}`}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton.Box key={index} width={WIDTHS[index % WIDTHS.length]} height={12} />
      ))}
    </Skeleton.Region>
  );
}
