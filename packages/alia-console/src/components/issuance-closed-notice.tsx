/**
 * The one place the console tells a developer that Alia no longer issues
 * applications or credentials.
 *
 * It exists as a component rather than as prose repeated on two screens because
 * the two screens say the same thing for the same reason, and a message that
 * drifts between them is a message a reader stops trusting. It is presentational
 * and stateless — no fetch, no store — so it renders identically whether or not
 * the caller is signed in.
 *
 * What it deliberately does NOT say: any removal date. `docs/migration/
 * compatibility-window.md` sets none, and announcing a date that then moves is
 * the failure that document exists to prevent. The API says the same thing on
 * the wire — every closed creation path answers `410` carrying `Deprecation` and
 * a `Link`, and no `Sunset`, for exactly this reason.
 */

import { HugeiconsIcon } from '@hugeicons/react';
import { InformationCircleIcon } from '@hugeicons/core-free-icons';

import { cn } from '@/lib/utils';

export function IssuanceClosedNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3',
        className,
      )}
    >
      <HugeiconsIcon
        icon={InformationCircleIcon}
        size={16}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <div className="text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Alia no longer issues API keys</p>
        <p className="mt-1">
          Register an application in Oxy Console and call{' '}
          <span className="font-mono text-foreground">api.oxy.so/v1</span>. Keys Alia already
          issued keep working, and you can review, rename, re-scope and revoke them here until
          the compatibility window closes.
        </p>
      </div>
    </div>
  );
}
