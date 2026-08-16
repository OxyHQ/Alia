import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The product-specific socket events — epic #139 workstream 13, "Preserve
 * notifications and product-specific events" and the wire half of "Preserve
 * approval requests/results".
 *
 * ## Why a socket event is the easiest thing in the product to delete by accident
 *
 * Nothing throws when an event nobody is listening for is emitted, and nothing
 * throws when a listener binds a name nobody emits. Renaming
 * `alia.approval_request` to `alia.approvalRequest` on either side compiles,
 * deploys, passes every existing test, and silently removes interactive
 * approvals from the product. The same is true of `notification`,
 * `agent-activity` and `show:progress`.
 *
 * So the required name set is derived from the CONSUMER — the app's own
 * `socket.on(...)` calls, read off disk — rather than written out here from
 * memory, and every name in it is then produced by driving the real emitter
 * against a real Socket.IO server.
 *
 * ## Why the real server and not a mock
 *
 * Both halves are measured through the adapter's `broadcast`, which is the
 * function Socket.IO itself calls with the packet and the target rooms. Mocking
 * `io.to(...).emit(...)` would assert that a name this file chose was passed to
 * a function this file wrote; reading the broadcast asserts what the server was
 * actually asked to send, and to whom.
 */

const H = vi.hoisted(() => ({
  notificationRow: {
    id: 'notif-ws13',
    oxyUserId: 'user-ws13',
    type: 'chat_response_ready',
    title: 'Alia has responded',
    body: 'the answer',
    priority: 'normal',
    data: { conversationId: 'conv-ws13' },
    channels: ['in_app'],
    deliveryStatus: { in_app: 'pending' },
    createdAt: new Date(0),
  },
}));

// The two things a socket server needs that a unit test cannot supply.
vi.mock('../lib/redis.js', () => ({
  getRedisClient: vi.fn(() => null),
  getRedisSubClient: vi.fn(() => null),
}));
vi.mock('../middleware/auth.js', () => ({
  oxyClient: { authSocket: vi.fn(() => (_socket: unknown, next: () => void) => next()) },
}));

// Stores only. `notification-service.ts` itself, and its channel resolution, run.
vi.mock('../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../db/notifications/notificationRepository.js', () => ({
  createNotification: vi.fn(async () => H.notificationRow),
  setDeliveryStatus: vi.fn(async () => undefined),
  hasActivePushToken: vi.fn(async () => false),
  hasActiveWebPushSubscription: vi.fn(async () => false),
  countUnread: vi.fn(async () => 0),
  listActivePushTokens: vi.fn(async () => []),
  listActiveWebPushSubscriptions: vi.fn(async () => []),
  deactivatePushTokenById: vi.fn(async () => undefined),
  deactivatePushTokenByToken: vi.fn(async () => undefined),
  deactivateWebPushSubscriptionById: vi.fn(async () => undefined),
  dismissNotification: vi.fn(async () => true),
  markAllNotificationsRead: vi.fn(async () => 0),
  markNotificationRead: vi.fn(async () => true),
  touchPushTokens: vi.fn(async () => undefined),
}));
vi.mock('../db/integrations/botRepository.js', () => ({
  findSystemBot: vi.fn(async () => null),
  findLinkedBotUser: vi.fn(async () => null),
}));
vi.mock('../db/integrations/connectedAccountRepository.js', () => ({
  findConnectedAccountForChannel: vi.fn(async () => null),
}));
vi.mock('../lib/channels/outbound.js', () => ({ sendChannelMessage: vi.fn(async () => []) }));

vi.mock('../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { general: child, agents: child, chat: child, v1: child, providers: child, codea: child, triggers: child },
  };
});

import {
  emitAgentActivity,
  emitApprovalRequest,
  emitApprovalResult,
  emitAudioJobUpdate,
  emitCanvasUpdate,
  emitTelegramLinked,
  emitWorkflowProgress,
  initSocket,
} from '../socket.js';
import type { Server } from 'socket.io';
import { sendNotification } from '../lib/notification-service.js';

// ── The recorder: what the server was asked to broadcast ───────────────────

interface Broadcast {
  event: string;
  rooms: string[];
  payload: unknown;
}

const broadcasts: Broadcast[] = [];
const server = http.createServer();
let io: Server;

beforeAll(() => {
  io = initSocket(server);
  const adapter = io.of('/').adapter;
  vi.spyOn(adapter, 'broadcast').mockImplementation((packet, opts) => {
    const data = (packet as { data: [string, unknown] }).data;
    broadcasts.push({
      event: data[0],
      rooms: [...((opts as { rooms?: Set<string> }).rooms ?? [])],
      payload: data[1],
    });
  });
});

afterAll(async () => {
  await io.close();
  server.close();
});

beforeEach(() => {
  broadcasts.length = 0;
});

// ===========================================================================
// Every emitter, by name and by room
// ===========================================================================

describe('each product event is emitted under its own name, to its own room', () => {
  it('approval request and result, on the agent session room', () => {
    emitApprovalRequest('sess-ws13', {
      requestId: 'req-1',
      agentId: 'agent-ws13',
      toolName: 'shell',
      args: { command: 'ls' },
      description: 'why',
      severity: 'critical',
      timeout: 60_000,
    });
    emitApprovalResult('sess-ws13', { requestId: 'req-1', decision: 'approved' });

    expect(broadcasts.map((entry) => entry.event)).toEqual([
      // The legacy spelling has no consumer left in this repo; it is emitted
      // alongside the namespaced one so an older client keeps working. Recorded
      // so that dropping it is a deliberate edit rather than a surprise.
      'agent-approval-request',
      'alia.approval_request',
      'agent-approval-result',
      'alia.approval_result',
    ]);
    for (const entry of broadcasts) {
      expect(entry.rooms).toEqual(['agent-session:sess-ws13']);
    }
    // The two spellings are one event: same payload, so they are an alias pair
    // rather than two events that could drift.
    expect(broadcasts[0].payload).toEqual(broadcasts[1].payload);
    expect(broadcasts[1].payload).toMatchObject({
      eventVersion: 1,
      requestId: 'req-1',
      toolName: 'shell',
      args: { command: 'ls' },
    });
    expect(broadcasts[3].payload).toEqual({ eventVersion: 1, requestId: 'req-1', decision: 'approved' });
  });

  it('agent activity, to the agent room AND the session room', () => {
    emitAgentActivity('agent-ws13', {
      type: 'tool_call',
      content: 'running',
      timestamp: 1,
      sessionId: 'sess-ws13',
    });

    // Two rooms, not one: the agent detail screen and the in-chat task card are
    // different subscribers, and dropping either silently blanks one of them.
    expect(broadcasts.map((entry) => ({ event: entry.event, rooms: entry.rooms }))).toEqual([
      { event: 'agent-activity', rooms: ['agent:agent-ws13'] },
      { event: 'agent-activity', rooms: ['agent-session:sess-ws13'] },
    ]);
    expect(broadcasts[0].payload).toMatchObject({ agentId: 'agent-ws13', type: 'tool_call' });
  });

  it('audio job, telegram link, canvas and workflow, each on its own room', () => {
    emitAudioJobUpdate('user-ws13', { jobId: 'job-1', status: 'completed', audioUrl: 'https://x.test/a.mp3' });
    emitTelegramLinked('tok-1', { linked: true });
    emitCanvasUpdate('conv-ws13', { kind: 'chart' });
    emitWorkflowProgress('exec-1', { step: 2 });

    expect(broadcasts.map((entry) => ({ event: entry.event, rooms: entry.rooms }))).toEqual([
      { event: 'audio:job-update', rooms: ['user:user-ws13'] },
      { event: 'telegram-linked', rooms: ['telegram-token:tok-1'] },
      { event: 'canvas-update', rooms: ['canvas:conv-ws13'] },
      { event: 'workflow-progress', rooms: ['workflow:exec-1'] },
    ]);
  });

  it('a notification reaches the user room as `notification`, through the service', async () => {
    // The one event emitted from outside `socket.ts`: `deliverInApp` reads
    // `getIO()` and writes to the same user room the app subscribes to
    // (`notification-service.ts:112-126`).
    const sent = await sendNotification({
      userId: 'user-ws13',
      type: 'chat_response_ready',
      title: 'Alia has responded',
      body: 'the answer',
      channels: ['in_app'],
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].event).toBe('notification');
    expect(broadcasts[0].rooms).toEqual(['user:user-ws13']);
    expect(broadcasts[0].payload).toEqual({
      id: 'notif-ws13',
      type: 'chat_response_ready',
      title: 'Alia has responded',
      body: 'the answer',
      priority: 'normal',
      data: { conversationId: 'conv-ws13' },
      createdAt: H.notificationRow.createdAt,
    });
    // Delivery is recorded as having succeeded, which is what makes a later
    // "was it delivered?" answerable rather than assumed.
    expect(sent.deliveryStatus).toEqual({ in_app: 'sent' });
  });
});

// ===========================================================================
// The required set, derived from the app rather than from memory
// ===========================================================================

/**
 * Every `socket.on('<name>', …)` in `packages/app`, minus the three names
 * Socket.IO itself owns.
 *
 * Read off disk deliberately: a list written here would be a list that agrees
 * with the API by construction, and the failure this guards is precisely the two
 * sides disagreeing.
 */
function appSocketListeners(): { names: string[]; filesScanned: number } {
  const appRoot = path.resolve(import.meta.dirname, '../../../app');
  const names = new Set<string>();
  let filesScanned = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.expo' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      filesScanned += 1;
      const source = fs.readFileSync(full, 'utf8');
      for (const line of source.split('\n')) {
        // Line-based on purpose: `socket.on('x'` never spans a newline in this
        // codebase, and a comment is excluded rather than counted.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        for (const match of line.matchAll(/\bsocket(?:Ref\.current)?\??\.on\(\s*['"]([^'"]+)['"]/g)) {
          names.add(match[1]);
        }
      }
    }
  };

  walk(path.join(appRoot, 'lib'));
  walk(path.join(appRoot, 'app'));

  for (const transport of ['connect', 'disconnect', 'connect_error']) names.delete(transport);
  return { names: [...names].sort(), filesScanned };
}

describe('every socket event the app listens for is one the API emits', () => {
  const { names, filesScanned } = appSocketListeners();

  it('read the app at all, so an empty required set cannot pass as agreement', () => {
    expect(filesScanned).toBeGreaterThan(100);
    expect(names.length).toBeGreaterThanOrEqual(5);
    // A positive control on the scanner itself: a name it is KNOWN to find.
    expect(names).toContain('alia.approval_request');
  });

  it('emits every name the app binds, and the census can tell a miss from a hit', () => {
    /**
     * Driving all seven emitters plus the notification service once, and reading
     * the union of the names they produced. This is what the app must find.
     */
    broadcasts.length = 0;
    emitApprovalRequest('s', { requestId: 'r', agentId: 'a', toolName: 't', args: {}, description: '', severity: 'info', timeout: 1 });
    emitApprovalResult('s', { requestId: 'r', decision: 'approved' });
    emitAgentActivity('a', { type: 'system', content: '', timestamp: 1, sessionId: 's' });
    emitAudioJobUpdate('u', { jobId: 'j', status: 'completed' });
    emitTelegramLinked('t', {});
    emitCanvasUpdate('c', {});
    emitWorkflowProgress('e', {});
    const emitted = new Set(broadcasts.map((entry) => entry.event));
    // `notification` and `show:progress` are emitted by their own services
    // rather than by `socket.ts`; each is named with the file that emits it so
    // the exemption is checkable rather than a hole.
    emitted.add('notification'); // lib/notification-service.ts:116, driven above
    emitted.add('show:progress'); // lib/show/show-pipeline.ts:63

    const unemitted = names.filter((name) => !emitted.has(name));
    expect(unemitted).toEqual([]);

    // The negative control: the census WOULD report a name the API does not
    // emit. Without it, an empty `unemitted` is also what a broken filter says.
    expect([...names, 'alia.event_nobody_emits'].filter((name) => !emitted.has(name))).toEqual([
      'alia.event_nobody_emits',
    ]);
  });
});
