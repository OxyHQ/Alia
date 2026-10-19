import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  session: { user: { id: 'payer-one' }, activeSessionId: 'session-one', isAuthenticated: true },
  checkout: vi.fn(),
  openURL: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => mocks.session,
  useAuth: () => ({ ...mocks.session, signIn: vi.fn() }),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <>{children}</>,
  useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock('expo-linking', () => ({ openURL: (...args: unknown[]) => mocks.openURL(...args) }));
vi.mock('expo-router', () => ({ useRouter: () => ({}), useLocalSearchParams: () => ({}) }));
vi.mock('@/features/billing/runtime/use-credits', () => ({ useCredits: () => ({}) }));
vi.mock('@/features/billing/runtime/use-checkout-confirmation', () => ({
  useCheckoutConfirmation: () => {},
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress }: { children: ReactNode; onPress(): void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock('@oxy.so/bloom/typography', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@oxy.so/bloom/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@oxy.so/bloom/icons/RiErrorWarningLine', () => ({ RiErrorWarningLine: () => null }));
vi.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
vi.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children }: { children: ReactNode }) => <>{children}</>,
  ScreenScrollView: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: (...args: unknown[]) => mocks.error(...args), success: vi.fn() },
}));
vi.mock('@/features/billing/ui/subscribe-shared', () => ({
  BillingToggle: () => null,
  InfoBanners: () => null,
  PageFooter: () => null,
  SubscribeHeader: () => null,
  PlanGrid: ({ onSubscribe }: { onSubscribe(id: string): void }) => (
    <button onClick={() => onSubscribe('pro')}>Subscribe</button>
  ),
}));
vi.mock('../use-billing', () => ({
  useProductCheckoutOptions: () => ({ data: { available: true, plans: [] } }),
  useSubscriptionPlans: () => ({
    data: [{ id: 'pro', name: 'Pro', monthlyPrice: 999, annualPrice: 9590, creditsPerMonth: 100 }],
  }),
  useSubscription: () => ({}),
  useCreateSubscriptionCheckout: () => ({
    mutateAsync: (...args: unknown[]) => mocks.checkout(...args),
  }),
  useChangePlan: () => ({}),
  useCancelSubscription: () => ({}),
}));
const { default: SubscribeScreen } = await import('../../../../../app/(biglayout)/subscribe');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  mocks.session.user = { id: 'payer-one' };
  mocks.session.activeSessionId = 'session-one';
  mocks.checkout.mockReset();
  mocks.openURL.mockReset();
  mocks.error.mockReset();
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
});
it.each(['switch', 'unmount'])('does not open the old checkout after %s', async (mode) => {
  let resolve!: (value: { url: string }) => void;
  mocks.checkout.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  act(() => {
    renderer = create(<SubscribeScreen />);
  });
  let action!: Promise<void>;
  act(() => {
    action = renderer!.root.findByType('button').props.onClick();
  });
  if (mode === 'switch') {
    mocks.session.user = { id: 'payer-two' };
    mocks.session.activeSessionId = 'session-two';
    act(() => renderer?.update(<SubscribeScreen />));
  } else {
    act(() => renderer?.unmount());
    renderer = null;
  }
  await act(async () => {
    resolve({ url: 'https://checkout.peable.to/c/old' });
    await action;
  });
  expect(mocks.openURL).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
});
it('retains a safe review link and never opens a payment when reconciliation is required', async () => {
  mocks.checkout.mockRejectedValue(new Error('PAYMENT_REVIEW_REQUIRED'));
  act(() => {
    renderer = create(<SubscribeScreen />);
  });
  await act(async () => renderer!.root.findByType('button').props.onClick());
  expect(mocks.error).toHaveBeenCalledWith('subscribe.paymentReview');
  expect(mocks.openURL).not.toHaveBeenCalled();
  const review = renderer!.root
    .findAllByType('button')
    .find((button) => button.props.children === 'subscribe.reviewPayment');
  act(() => review!.props.onClick());
  expect(mocks.openURL).toHaveBeenCalledWith('https://peable.to');
});
