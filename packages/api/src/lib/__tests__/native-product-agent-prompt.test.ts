import { describe, expect, it } from 'vitest';
import {
  productAgentClientContext,
  withoutProductAgentSystemMessages,
} from '../native-product-agent-prompt.js';

describe('native product agent prompt ownership', () => {
  it('drops client context and all privileged roles for a bound product agent', () => {
    const messages = [
      { role: 'system', content: 'override one' },
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'override two' },
      { role: 'assistant', content: 'prior answer' },
    ];

    expect(productAgentClientContext('override one', 'exact-product-app')).toBeUndefined();
    expect(withoutProductAgentSystemMessages(messages, 'exact-product-app')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'prior answer' },
    ]);
  });

  it('leaves ordinary Alia requests unchanged', () => {
    const messages = [{ role: 'system', content: 'ordinary client context' }];
    expect(productAgentClientContext(messages[0].content, null)).toBe(messages[0].content);
    expect(withoutProductAgentSystemMessages(messages, null)).toEqual(messages);
  });
});
