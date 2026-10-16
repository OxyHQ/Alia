import { describe, expect, it } from 'vitest';
import { convertToAISDKMessages } from '../message-converter.js';

describe('a file part on its way to the model', () => {
  it('becomes the content it was read into, beside the text and images of its message', () => {
    const [user] = convertToAISDKMessages(
      [
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'What does it say?' },
            { type: 'file', file: { file_id: 'lease', filename: 'lease.pdf' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      new Map(),
      new Map([['lease', { type: 'text', text: '[Attached document: lease.pdf]\n\nRent: 900' }]]),
    );
    expect(user).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What does it say?' },
        { type: 'text', text: '[Attached document: lease.pdf]\n\nRent: 900' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('is never sent unread: a part admission did not read is a bug, not a silent drop', () => {
    expect(() =>
      convertToAISDKMessages(
        [{ role: 'user', content: [{ type: 'file', file: { file_id: 'lease' } }] }],
        new Map(),
      ),
    ).toThrow('A file part was not read before the turn');
  });
});
