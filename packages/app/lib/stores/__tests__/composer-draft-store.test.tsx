import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  releaseAttachmentUri,
  useComposerDraft,
  useComposerDraftStore,
  type ComposerDraft,
  type DraftTarget,
} from '../composer-draft-store';
import type { Attachment } from '../global-store';

/**
 * A draft belongs to one account and one composer (#608 §4).
 *
 * The attachments used to be ONE global list and the text a `useState` per
 * mounted screen, so a picture added in one chat sat in the composer of every
 * chat the drawer kept mounted, and nothing reset either when the account
 * changed. These pin the two scopes, and the release of the temporary URLs a
 * draft's attachments hold whenever a draft is let go of.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const revoked: string[] = [];
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  revoked.length = 0;
  URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url));
  useComposerDraftStore.setState({ account: null, drafts: {} });
});
afterEach(() => {
  URL.revokeObjectURL = originalRevoke;
});

const store = () => useComposerDraftStore.getState();
const draftOf = (target: DraftTarget) => store().drafts[target ?? ''];

function picture(id: string, uri = `blob:http://app/${id}`): Attachment {
  return { id, uri, type: 'image', name: `${id}.png`, size: 1, mimeType: 'image/png' };
}

describe('one draft per composer', () => {
  beforeEach(() => store().bindAccount('A'));

  it('keeps each conversation’s text and files to itself', () => {
    store().setText(store().address('c1'), 'first chat');
    store().addAttachment(store().address('c1'), picture('p1'));
    store().setText(store().address(null), 'new chat');

    expect(draftOf('c1')).toMatchObject({ text: 'first chat', attachments: [{ id: 'p1' }] });
    expect(draftOf(null)).toMatchObject({ text: 'new chat', attachments: [] });
    expect(draftOf('c2')).toBeUndefined();
  });

  it('shows a mounted screen its own draft only, whichever route is active', () => {
    const seen: Record<string, ComposerDraft> = {};
    function Screen({ target }: { target: DraftTarget }) {
      seen[target ?? 'new'] = useComposerDraft(target);
      return null;
    }
    // The drawer keeps both mounted at once.
    act(() => {
      create(
        <>
          <Screen target={null} />
          <Screen target="c1" />
        </>,
      );
    });

    // A failed send in c1 hands its draft back — to c1, not to the new chat.
    act(() => store().restore(store().address('c1'), { text: 'retry me', attachments: [picture('p1')] }));

    expect(seen.c1).toMatchObject({ text: 'retry me', attachments: [{ id: 'p1' }] });
    expect(seen.new).toMatchObject({ text: '', attachments: [] });
  });

  it('releases a removed attachment’s URL, and only that one', () => {
    const address = store().address('c1');
    store().addAttachment(address, picture('p1'));
    store().addAttachment(address, picture('p2'));

    store().removeAttachment(address, 'p2');

    expect(revoked).toEqual(['blob:http://app/p2']);
    expect(draftOf('c1')?.attachments.map((a) => a.id)).toEqual(['p1']);
  });

  it('empties for a send without releasing what the send still needs', () => {
    const address = store().address('c1');
    store().setText(address, 'hi');
    store().addAttachment(address, picture('p1'));

    store().clear(address);

    expect(draftOf('c1')).toBeUndefined();
    expect(revoked).toEqual([]);
  });

  it('puts a failed send back in front of what was added since', () => {
    const address = store().address('c1');
    store().addAttachment(address, picture('later'));

    store().restore(address, { text: 'sent', attachments: [picture('sent')], mcpServerId: 'm1', skillNames: ['s'] });

    expect(draftOf('c1')).toEqual({
      text: 'sent',
      attachments: [picture('sent'), picture('later')],
      mcpServerId: 'm1',
      skillNames: ['s'],
    });
  });

  it('changes the turn from what the draft holds now', () => {
    const address = store().address('c1');
    store().updateTurn(address, (turn) => ({ ...turn, skillNames: [...turn.skillNames, 'a'] }));
    store().updateTurn(address, (turn) => ({ ...turn, skillNames: [...turn.skillNames, 'b'] }));

    expect(draftOf('c1')?.skillNames).toEqual(['a', 'b']);
  });
});

describe('one account’s drafts', () => {
  it('drops every draft, and releases its files, when the account changes', () => {
    store().bindAccount('A');
    store().setText(store().address('c1'), 'A’s secret');
    store().addAttachment(store().address(null), picture('p1'));

    store().bindAccount('B');

    expect(store().drafts).toEqual({});
    expect(revoked).toEqual(['blob:http://app/p1']);
  });

  it('drops them on sign-out too', () => {
    store().bindAccount('A');
    store().setText(store().address(null), 'draft');

    store().bindAccount(null);

    expect(store().drafts).toEqual({});
  });

  it('carries a signed-out draft into the sign-in its send asked for', () => {
    store().setText(store().address(null), 'typed before signing in');
    store().addAttachment(store().address(null), picture('p1'));

    store().bindAccount('A');

    expect(draftOf(null)).toMatchObject({ text: 'typed before signing in', attachments: [{ id: 'p1' }] });
    expect(revoked).toEqual([]);
  });

  it('refuses a late write for the account that left, and releases its files', () => {
    store().bindAccount('A');
    // Taken when A sent; the request fails after B signed in.
    const sentByA = store().address('c1');
    store().bindAccount('B');

    store().restore(sentByA, { text: 'A’s message', attachments: [picture('p1')] });
    store().addAttachment(sentByA, picture('p2'));

    expect(store().drafts).toEqual({});
    expect(revoked).toEqual(['blob:http://app/p1', 'blob:http://app/p2']);
  });

  it('shows a mounted screen the new account’s empty draft', () => {
    store().bindAccount('A');
    store().setText(store().address('c1'), 'A’s words');
    let seen: ComposerDraft | null = null;
    function Screen() {
      seen = useComposerDraft('c1');
      return null;
    }
    act(() => {
      create(<Screen />);
    });
    expect(seen).toMatchObject({ text: 'A’s words' });

    act(() => store().bindAccount('B'));

    expect(seen).toMatchObject({ text: '', attachments: [] });
  });
});

describe('releasing a temporary URL', () => {
  it('revokes an object URL and leaves a data URL alone', () => {
    releaseAttachmentUri('blob:alia/kept-forever');
    releaseAttachmentUri('data:image/png;base64,AAAA');
    releaseAttachmentUri(undefined);

    expect(revoked).toEqual(['blob:alia/kept-forever']);
  });
});
