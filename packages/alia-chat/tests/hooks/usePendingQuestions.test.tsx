import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { usePendingQuestions } from '../../src/hooks/usePendingQuestions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Message = Parameters<typeof usePendingQuestions>[0][number];

const asked = (id: string): Message => ({
  id,
  role: 'assistant',
  toolInvocations: [
    {
      toolCallId: `call-${id}`,
      toolName: 'askUserQuestion',
      state: 'result',
      args: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] },
    },
  ],
});
const answer: Message = { id: 'u', role: 'user' };

let renderer: ReactTestRenderer | null = null;
let seen: ReturnType<typeof usePendingQuestions>;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function Probe({ messages, streaming }: { messages: Message[]; streaming: boolean }) {
  seen = usePendingQuestions(messages, streaming);
  return null;
}
function render(messages: Message[], streaming = false) {
  const element = <Probe messages={messages} streaming={streaming} />;
  act(() => {
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}

describe('the questions Alia asked and the person has not answered', () => {
  it('are pending after her turn, not while she is still answering, and not once anything follows', () => {
    render([asked('a1')]);
    expect(seen.questions).toHaveLength(1);

    render([asked('a1')], true);
    expect(seen.questions).toEqual([]);

    render([asked('a1'), answer]);
    expect(seen.questions).toEqual([]);
  });

  it('go away when dismissed, and come back with her next question', () => {
    render([asked('a1')]);
    act(() => seen.dismiss());
    expect(seen.questions).toEqual([]);

    render([asked('a1'), answer, asked('a2')]);
    expect(seen.questions).toHaveLength(1);
  });
});
