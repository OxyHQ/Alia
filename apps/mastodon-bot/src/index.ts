// Load environment variables
if (process.env.NODE_ENV !== 'production') {
  try {
    const dotenv = await import('dotenv');
    dotenv.config();
  } catch (e) {
    console.error('[Mastodon Bot] Failed to load dotenv:', e);
  }
}

import { createRestAPIClient } from 'masto';
import { handleMentions } from './handlers/mentions.js';

// Validate required environment variables
const requiredEnvVars = [
  'MASTODON_INSTANCE_URL',
  'MASTODON_ACCESS_TOKEN',
  'API_BASE_URL',
  'MASTODON_BOT_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`[Mastodon Bot] Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const INSTANCE_URL = process.env.MASTODON_INSTANCE_URL!;
const ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN!;
const NOTIFICATION_POLL_INTERVAL = parseInt(process.env.NOTIFICATION_POLL_INTERVAL || '30000');

// Track last processed notification to avoid duplicates
let lastNotificationId: string | null = null;

/**
 * Initialize the Mastodon bot
 */
async function initializeBot() {
  try {
    console.log('[Mastodon Bot] Initializing...');

    // Create Mastodon client
    const masto = createRestAPIClient({
      url: INSTANCE_URL,
      accessToken: ACCESS_TOKEN,
    });

    // Verify credentials and get account info
    const account = await masto.v1.accounts.verifyCredentials();
    console.log(`[Mastodon Bot] Connected successfully!`);
    console.log(`[Mastodon Bot] Account: @${account.acct}`);
    console.log(`[Mastodon Bot] Display Name: ${account.displayName}`);
    console.log(`[Mastodon Bot] Instance: ${INSTANCE_URL}`);
    console.log(`[Mastodon Bot] Polling interval: ${NOTIFICATION_POLL_INTERVAL}ms`);

    // Store bot account ID for later use
    const botAccountId = account.id;

    // Start polling for mentions
    startPolling(masto, botAccountId);

    console.log('[Mastodon Bot] Bot started successfully! Listening for mentions...');
  } catch (error: any) {
    console.error('[Mastodon Bot] Failed to initialize:', error);
    if (error.response) {
      console.error('[Mastodon Bot] API Response:', error.response.data);
    }
    process.exit(1);
  }
}

/**
 * Start polling for new mentions
 */
function startPolling(masto: any, botAccountId: string) {
  console.log('[Mastodon Bot] Starting mention polling...');

  // Poll immediately on startup
  pollMentions(masto, botAccountId);

  // Then poll at regular intervals
  setInterval(() => {
    pollMentions(masto, botAccountId);
  }, NOTIFICATION_POLL_INTERVAL);
}

/**
 * Poll for new mentions
 */
async function pollMentions(masto: any, botAccountId: string) {
  try {
    // Fetch notifications (mentions only)
    const notifications = await masto.v1.notifications.list({
      types: ['mention'],
      limit: 20,
      ...(lastNotificationId ? { sinceId: lastNotificationId } : {}),
    });

    if (notifications.length === 0) {
      return; // No new mentions
    }

    console.log(`[Mastodon Bot] Found ${notifications.length} new mention(s)`);

    // Update last notification ID to newest one
    lastNotificationId = notifications[0].id;

    // Process mentions in chronological order (oldest first)
    for (const notification of notifications.reverse()) {
      try {
        await handleMentions(masto, notification, botAccountId);
      } catch (error) {
        console.error('[Mastodon Bot] Error handling mention:', error);
        // Continue processing other mentions even if one fails
      }
    }
  } catch (error: any) {
    console.error('[Mastodon Bot] Error polling mentions:', error);
    if (error.response) {
      console.error('[Mastodon Bot] API Response:', error.response.data);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('[Mastodon Bot] Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Mastodon Bot] Shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error('[Mastodon Bot] Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('[Mastodon Bot] Uncaught exception:', error);
  process.exit(1);
});

// Start the bot
initializeBot();
