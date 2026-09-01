import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ claim: vi.fn(async () => false) }));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  claimAutomationEvent: state.claim,
  createAutomationRunForSession: vi.fn(),
  markAutomationEventStatus: vi.fn(),
  matchingEventAutomations: vi.fn(async () => []),
}));
vi.mock('../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: vi.fn(), updateAgentSession: vi.fn(),
}));
vi.mock('../../db/agents/agentRepository.js', () => ({ findAgentById: vi.fn() }));
vi.mock('../../lib/tools/oxy-services.js', () => ({ getOxyAgentCapabilityMap: vi.fn() }));
vi.mock('../../lib/task-queue.js', () => ({ enqueueAgentSession: vi.fn() }));
vi.mock('../../lib/notification-service.js', () => ({ sendNotification: vi.fn() }));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: child, general: child } };
});

const serviceFetch = vi.fn();
vi.stubGlobal('fetch', serviceFetch);
const { default: router } = await import('../oxy-service-events.js');

let server: Server;
let port: number;

function post(body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1', port, path: '/webhooks/oxy', method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(json),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      }));
    });
    request.on('error', reject);
    request.end(json);
  });
}

const event = {
  eventId: 'message-1:new_email', appId: 'inbox', accountId: 'account-1',
  resource: {
    appId: 'inbox', effectiveAccountId: 'account-1',
    resourceType: 'mailbox', resourceId: 'mailbox-1',
  },
  type: 'new_email', occurredAt: '2026-09-02T10:00:00.000Z',
  data: { messageId: 'message-1', mailboxId: 'mailbox-1' },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/oxy', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');
  port = address.port;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

beforeEach(() => {
  state.claim.mockReset().mockResolvedValue(false);
  serviceFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({
    service: { appId: 'application-1', scopes: ['capability-events:publish'] },
    catalogAppIds: ['inbox'],
    catalogs: [{ appId: 'inbox', eventTypes: ['new_email', 'email_needs_response'] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
});

describe('normalized Oxy app events', () => {
  it('requires a centrally verifiable service bearer before claiming an event', async () => {
    expect((await post(event)).status).toBe(401);
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(state.claim).not.toHaveBeenCalled();
  });

  it('refuses an app that is not owned by the publisher catalog', async () => {
    serviceFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      service: { appId: 'application-1', scopes: ['capability-events:publish'] },
      catalogAppIds: ['mention'],
      catalogs: [{ appId: 'mention', eventTypes: ['post_created'] }],
    }), { status: 200 }));
    const response = await post(event, 'service-token');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('catalog_not_owned_by_service');
    expect(state.claim).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate without dispatching a second effect', async () => {
    const response = await post(event, 'service-token');
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true, duplicate: true });
    expect(state.claim).toHaveBeenCalledTimes(1);
  });

  it('rejects a resource that claims a different app', async () => {
    const response = await post({ ...event, resource: { ...event.resource, appId: 'mention' } }, 'service-token');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('event_resource_app_mismatch');
    expect(serviceFetch).not.toHaveBeenCalled();
  });

  it('rejects a resource that claims a different effective account', async () => {
    const response = await post({
      ...event,
      resource: { ...event.resource, effectiveAccountId: 'account-2' },
    }, 'service-token');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('event_resource_account_mismatch');
    expect(serviceFetch).not.toHaveBeenCalled();
  });

  it('rejects event types that are not declared by the signed app catalog', async () => {
    const response = await post({ ...event, type: 'invented_event' }, 'service-token');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('event_type_not_in_catalog');
    expect(state.claim).not.toHaveBeenCalled();
  });
});
