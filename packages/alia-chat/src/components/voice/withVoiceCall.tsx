/**
 * A chat component with the voice call: `Component` drawn under `VoiceCallContext`, which hands
 * it `AliaVoiceCall`. The root entry and `@alia.onl/sdk/ask` export their chat through this; the
 * text-only entries export the components as they are.
 */

import type { ComponentType } from 'react';
import { AliaVoiceCall } from './AliaVoiceCall';
import { VoiceCallContext } from './VoiceCallContext';

export function withVoiceCall<P extends object>(
  Component: ComponentType<P>,
  displayName: string,
): ComponentType<P> {
  // A ref is a prop of a function component (React 19), so it reaches a `forwardRef` `Component`.
  function WithVoiceCall(props: P) {
    return (
      <VoiceCallContext.Provider value={AliaVoiceCall}>
        <Component {...props} />
      </VoiceCallContext.Provider>
    );
  }
  WithVoiceCall.displayName = displayName;
  return WithVoiceCall;
}
