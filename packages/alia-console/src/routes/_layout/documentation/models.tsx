/**
 * The developer-facing catalogue page.
 *
 * It used to hold a `const models = [...]` of four `alia-*` identifiers under a
 * heading "Available Models", introduced by "Alia offers a range of models" —
 * which is the exact thing #139 forbids, since every one of those identifiers is
 * a routing profile over third-party models and none is a model Alia owns. Its
 * numbers were invented too: `kaana-lite` was documented at 8K context and
 * `kaana-v1-pro-max` at 200K, matching nothing in the routing table.
 *
 * It now reads `GET /catalogue`, so it says what the API says and cannot drift.
 * See `hooks/use-catalogue.ts`.
 */

import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type {
  CapabilityAvailability,
  CatalogueEntry,
  TokenBound,
} from '@/hooks/use-catalogue';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCatalogue } from '@/hooks/use-catalogue';

export const Route = createFileRoute('/_layout/documentation/models')({
  component: ModelsDocPage,
});

/** `128000` reads as `128K`; an absent bound reads as unknown, never as zero. */
function formatBound(bound: TokenBound | null): string {
  if (bound === null) return 'Not recorded';
  const short = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return bound.guaranteed === bound.upTo
    ? short(bound.upTo)
    : `${short(bound.guaranteed)} guaranteed, up to ${short(bound.upTo)}`;
}

/**
 * Four states, not a checkmark.
 *
 * A routing profile answers from a different model each time, so "does it
 * support vision" genuinely has three true answers plus "we do not know".
 * Rendering `unknown` as absent is how a working feature gets greyed out.
 */
const CAPABILITY_LABEL: Readonly<Record<CapabilityAvailability, string>> = {
  always: 'Always',
  sometimes: 'Sometimes',
  never: 'No',
  unknown: 'Unknown',
};

function CapabilityRow({ label, value }: { label: string; value: CapabilityAvailability }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-sm font-medium">{CAPABILITY_LABEL[value]}</p>
    </div>
  );
}

function EntryCard({ entry }: { entry: CatalogueEntry }) {
  const { capabilities } = entry;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              {entry.displayName}
              <Badge variant={entry.kind === 'model' ? 'default' : 'secondary'} className="text-xs">
                {entry.kind === 'model' ? 'Model' : 'Routing profile'}
              </Badge>
              {entry.requiredPlan !== null && (
                <Badge variant="outline" className="text-xs">
                  {entry.requiredPlan}
                </Badge>
              )}
              {entry.legacy && (
                <Badge variant="outline" className="text-xs">
                  Legacy
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">{entry.description}</CardDescription>
          </div>
          <code className="text-xs font-mono bg-muted px-2 py-1 rounded whitespace-nowrap">
            {entry.id}
          </code>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Context window</p>
            <p className="text-sm font-medium">{formatBound(capabilities.contextWindow)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Max output</p>
            <p className="text-sm font-medium">{formatBound(capabilities.maxOutput)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Credit multiplier</p>
            <p className="text-sm font-medium">{entry.creditMultiplier}x</p>
          </div>
          {entry.selectsAmong !== null && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Selects among</p>
              <p className="text-sm font-medium">{entry.selectsAmong} models</p>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <CapabilityRow label="Tools" value={capabilities.tools} />
          <CapabilityRow label="Vision" value={capabilities.vision} />
          <CapabilityRow label="Audio" value={capabilities.audio} />
          <CapabilityRow label="Reasoning" value={capabilities.reasoning} />
          <CapabilityRow label="Structured output" value={capabilities.structuredOutput} />
        </div>
      </CardContent>
    </Card>
  );
}

function ModelsDocPage() {
  const { data: entries, isPending, isError } = useCatalogue();
  const offered = entries ?? [];
  const profiles = offered.filter((entry) => entry.kind === 'routing_profile');
  const models = offered.filter((entry) => entry.kind === 'model');

  return (
    <div className="flex-1 bg-background max-w-4xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/documentation"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Documentation
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">Catalogue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What you can send as <code className="text-xs bg-muted px-1 py-0.5 rounded">model</code>,
          and what it does
        </p>
      </div>

      {/* Overview */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Overview</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Alia does not publish models of its own. What you select is a{' '}
          <strong className="text-foreground">routing profile</strong>: a policy that picks
          among several third-party models on your behalf, so which model answers can differ
          between two requests under the same profile.
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          Send a profile id as the <code className="text-xs bg-muted px-1 py-0.5 rounded">model</code>{' '}
          parameter. Everything on this page is served by{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">GET /catalogue</code> — this page
          restates nothing, so it cannot fall out of step with what the API will accept.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">{profiles.length}</p>
            <p className="text-xs text-muted-foreground">Routing profiles</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">{models.length}</p>
            <p className="text-xs text-muted-foreground">Concrete models</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-2xl font-semibold text-foreground">
              {offered.filter((entry) => entry.requiredPlan === null).length}
            </p>
            <p className="text-xs text-muted-foreground">Without a paid plan</p>
          </div>
        </div>
      </div>

      {/* Catalogue */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">What you can select</h2>
        {isPending && <p className="text-sm text-muted-foreground">Loading the catalogue…</p>}
        {isError && (
          <p className="text-sm text-muted-foreground">
            The catalogue could not be loaded. Call{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">GET /catalogue</code> directly
            for the current list.
          </p>
        )}
        {!isPending && !isError && offered.length === 0 && (
          <p className="text-sm text-muted-foreground">The catalogue is currently empty.</p>
        )}
        <div className="space-y-4">
          {offered.map((entry) => (
            <EntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      </div>

      {/* Choosing */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Choosing a profile</h2>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">Order by cost</h3>
            <p className="text-sm text-muted-foreground">
              The catalogue is sorted by credit multiplier, cheapest first. The first entry is
              the least expensive way to answer a request; the last is the most capable.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">Read the capabilities</h3>
            <p className="text-sm text-muted-foreground">
              A profile reports <strong className="text-foreground">Sometimes</strong> for a
              capability when only some of the models it selects among support it, and{' '}
              <strong className="text-foreground">Unknown</strong> when we have no record either
              way. Unknown is not a no.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">Ask for reasoning effort</h3>
            <p className="text-sm text-muted-foreground">
              Effort is a request parameter, not a separate entry: send{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">reasoningEffort</code> —{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">instant</code>,{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">medium</code>,{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">high</code> or{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">max</code> — alongside any
              entry. Only the levels in that entry's{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">reasoning_levels</code> are
              sent to the provider; every route behind an entry has to support a level for it to
              appear there, so the list is empty for entries whose fallback could land somewhere
              that cannot honour it. Thinking is billed as output tokens.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              <code className="text-xs bg-muted px-1 py-0.5 rounded">thinkingMode: true</code> is
              still accepted and means{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">medium</code>.
            </p>
          </div>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/models"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">View model statistics</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
