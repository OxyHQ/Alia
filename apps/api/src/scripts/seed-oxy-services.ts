/**
 * Seed script: Register Oxy ecosystem services for Clarity
 *
 * Usage: npx tsx src/scripts/seed-oxy-services.ts
 *
 * Upserts service manifests so Clarity can interact with Oxy apps.
 * Safe to run multiple times — uses upsert by serviceId.
 */

import mongoose from 'mongoose';
import { OxyService, type IOxyService } from '../models/oxy-service.js';

const MONGODB_URI = process.env.MONGODB_URI!;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_NAME = `clarity-${NODE_ENV}`;

// ---------------------------------------------------------------------------
// Inbox (Email) service manifest
// ---------------------------------------------------------------------------

const inboxService: Partial<IOxyService> = {
  serviceId: 'oxy-inbox',
  displayName: 'Inbox',
  description: 'Access and manage the user\'s Oxy email — search, read, send, organize',
  version: '1.0.0',
  baseUrl: process.env.OXY_API_URL || 'https://api.oxy.so',
  status: 'active',
  isFirstParty: true,
  contextEndpoint: '/email/ai-context',
  tools: [
    {
      name: 'searchEmails',
      description: 'Search the user\'s emails by keyword, sender, date range, or other filters. Use when the user asks about specific emails, wants to find something, or asks questions about their inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Full-text search query' },
          from: { type: 'string', description: 'Filter by sender email address' },
          to: { type: 'string', description: 'Filter by recipient email address' },
          subject: { type: 'string', description: 'Filter by subject line' },
          hasAttachment: { type: 'boolean', description: 'Only emails with attachments' },
          dateAfter: { type: 'string', description: 'ISO date string — emails after this date' },
          dateBefore: { type: 'string', description: 'ISO date string — emails before this date' },
          label: { type: 'string', description: 'Filter by label ID' },
          limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
        },
      },
      endpoint: {
        method: 'GET',
        path: '/email/search',
        queryMapping: {
          q: 'q',
          from: 'from',
          to: 'to',
          subject: 'subject',
          hasAttachment: 'hasAttachment',
          dateAfter: 'dateAfter',
          dateBefore: 'dateBefore',
          label: 'label',
          limit: 'limit',
        },
      },
      resultMapping: {
        extract: 'data',
        summarize: ['from', 'subject', 'date', 'flags.seen', 'flags.starred'],
        maxChars: 8000,
      },
    },
    {
      name: 'getUnreadEmails',
      description: 'Get the user\'s unread emails. Use when the user asks about new mail, unread messages, or what needs attention.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
      endpoint: {
        method: 'GET',
        path: '/email/messages',
        queryMapping: {
          limit: 'limit',
        },
      },
      resultMapping: {
        extract: 'data',
        summarize: ['from', 'subject', 'date', 'flags.seen'],
        maxChars: 6000,
      },
    },
    {
      name: 'readEmail',
      description: 'Read the full content of a specific email message. Use when the user wants to see details of a particular email.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The email message ID' },
        },
        required: ['messageId'],
      },
      endpoint: {
        method: 'GET',
        path: '/email/messages/{messageId}',
      },
      resultMapping: {
        maxChars: 10000,
      },
    },
    {
      name: 'getEmailThread',
      description: 'Get all messages in an email conversation thread. Use to see the full context of an email conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Any message ID in the thread' },
        },
        required: ['messageId'],
      },
      endpoint: {
        method: 'GET',
        path: '/email/messages/{messageId}/thread',
      },
      resultMapping: {
        maxChars: 12000,
      },
    },
    {
      name: 'sendEmail',
      description: 'Send an email on behalf of the user. ALWAYS present the draft to the user and get explicit confirmation before sending.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Recipient display name' },
                address: { type: 'string', description: 'Recipient email address' },
              },
              required: ['address'],
            },
            description: 'Recipients',
          },
          cc: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
              },
              required: ['address'],
            },
            description: 'CC recipients (optional)',
          },
          subject: { type: 'string', description: 'Email subject line' },
          text: { type: 'string', description: 'Plain text body' },
          html: { type: 'string', description: 'HTML body (optional)' },
          inReplyTo: { type: 'string', description: 'Message-ID of the email being replied to' },
          references: { type: 'array', items: { type: 'string' }, description: 'Thread reference IDs' },
        },
        required: ['to', 'subject'],
      },
      endpoint: {
        method: 'POST',
        path: '/email/messages',
        bodyMapping: {
          to: 'to',
          cc: 'cc',
          subject: 'subject',
          text: 'text',
          html: 'html',
          inReplyTo: 'inReplyTo',
          references: 'references',
        },
      },
      confirmBeforeExecute: true,
    },
    {
      name: 'listMailboxes',
      description: 'List the user\'s email mailboxes/folders (Inbox, Sent, Drafts, Trash, custom folders).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      endpoint: {
        method: 'GET',
        path: '/email/mailboxes',
      },
    },
    {
      name: 'listLabels',
      description: 'List the user\'s email labels/categories.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      endpoint: {
        method: 'GET',
        path: '/email/labels',
      },
    },
    {
      name: 'moveEmail',
      description: 'Move an email to a different mailbox/folder (e.g., archive, trash).',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The email message ID' },
          mailboxId: { type: 'string', description: 'Target mailbox ID to move to' },
        },
        required: ['messageId', 'mailboxId'],
      },
      endpoint: {
        method: 'POST',
        path: '/email/messages/{messageId}/move',
        bodyMapping: {
          mailboxId: 'mailboxId',
        },
      },
    },
    {
      name: 'updateEmailFlags',
      description: 'Update email flags — mark as read/unread, star/unstar, pin/unpin.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The email message ID' },
          seen: { type: 'boolean', description: 'Mark as read (true) or unread (false)' },
          starred: { type: 'boolean', description: 'Star (true) or unstar (false)' },
          pinned: { type: 'boolean', description: 'Pin (true) or unpin (false)' },
        },
        required: ['messageId'],
      },
      endpoint: {
        method: 'PUT',
        path: '/email/messages/{messageId}/flags',
        bodyMapping: {
          seen: 'seen',
          starred: 'starred',
          pinned: 'pinned',
        },
      },
    },
    {
      name: 'getEmailQuota',
      description: 'Get the user\'s email storage quota and usage.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      endpoint: {
        method: 'GET',
        path: '/email/quota',
      },
    },
  ],
  events: [
    {
      name: 'new_email',
      description: 'A new email was received',
      action: 'notify',
    },
    {
      name: 'email_needs_response',
      description: 'An email was detected as needing a response',
      action: 'context',
    },
  ],
};

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

const services = [inboxService];

async function seed() {
  console.log(`Connecting to MongoDB: ${DB_NAME}...`);
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });

  for (const svc of services) {
    const result = await OxyService.findOneAndUpdate(
      { serviceId: svc.serviceId },
      { $set: svc },
      { upsert: true, new: true },
    );
    console.log(`✓ ${result.serviceId} (${result.displayName}) — ${result.tools.length} tools, ${result.events?.length || 0} events`);
  }

  console.log(`\nDone. ${services.length} service(s) seeded.`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
