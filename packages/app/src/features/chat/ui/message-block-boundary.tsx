import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
/**
 * One block of an answer, contained.
 *
 * ## What used to happen
 *
 * The blocks in a turn are built from what a tool returned, and a tool result
 * is data the app did not write. `cardOf` checks that `card.type` is one of
 * four known names and that `card.data` is truthy, and then hands `data`
 * straight to the card with an unchecked cast:
 *
 *     <WeatherCard data={card.data as WeatherCardData} />
 *
 * `WeatherCard` then reads `data.daily[selectedDay]`, `data.hourly.filter(...)`
 * and `data.current.temperature`, none of them guarded. A result shaped
 * `{ type: 'weather', data: { place: 'Madrid' } }` passes every check `cardOf`
 * makes and throws a `TypeError` on the first of those reads.
 *
 * A throw during render unwinds to the nearest boundary, and between a message
 * row and `AppErrorBoundary` in `app/(app)/_layout.tsx` there was nothing. So a
 * single malformed block did not degrade a card — it replaced the entire app
 * scene with the crash screen, taking the thread, the composer and the sidebar
 * with it. Reloading reopened the same conversation and hit the same block
 * again, which makes the conversation unreadable rather than merely broken.
 *
 * #608 §7 asks for the opposite: "presentación segura y error explícito, no
 * caída completa del chat".
 *
 * ## Why a boundary rather than validating the data
 *
 * Both, eventually — but they answer different questions. Validating each
 * card's payload says what a well-formed weather result looks like, and is
 * worth having. A boundary says that NO block, including the ones nobody has
 * thought about yet and the ones a future tool adds, can take the conversation
 * down with it. Only the second survives a card that is added next month.
 *
 * `retry` is deliberately not offered. The same data will be re-read and the
 * same block will throw again, and a button that cannot work is the thing #608
 * §1.6 rules out. What is offered is the truth: this part could not be shown,
 * and the rest of the answer below it still can.
 */
export function MessageBlockBoundary({
  children,
  onError,
}: {
  children: React.ReactNode;
  /**
   * Reported rather than swallowed. A block that throws is a defect in the
   * tool's output or in the card that reads it, and neither is visible from
   * here — the console line is what makes it findable.
   */
  onError?: (error: Error) => void;
}) {
  const { t } = useTranslation();

  return (
    <ErrorBoundary
      onError={(error) => {
        console.error("A message block failed to render:", error);
        onError?.(error);
      }}
      // Bloom's compact empty state — the panel rung, a glyph and one line —
      // rather than the boundary's default, whose Retry is ruled out above.
      fallback={
        <EmptyState
          variant="compact"
          icon={RiErrorWarningLine}
          description={t('chat.blockFailed')}
        />
      }
    >
      {children}
    </ErrorBoundary>
  );
}
