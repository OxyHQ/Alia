import express from 'express';
import { authenticateToken } from '../middleware/auth';
import mongoose from 'mongoose';
import crypto from 'crypto';

const router = express.Router();

// Telegram User Schema (should match the one in telegram-bot)
const TelegramUserSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
    },
    chatId: {
      type: String,
      required: true,
    },
    username: String,
    firstName: String,
    lastName: String,
    authToken: String,
    authTokenExpiry: Date,
    sessionToken: String,
    conversationId: String,
    isAuthenticated: {
      type: Boolean,
      default: false,
    },
    linkedAt: Date,
  },
  {
    timestamps: true,
  }
);

const TelegramUser = mongoose.model('TelegramUser', TelegramUserSchema);

// Helper to generate auth token
function generateAuthToken(): string {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Get or create telegram user
router.post('/users', async (req, res) => {
  try {
    const { telegramId, chatId, username, firstName, lastName } = req.body;

    if (!telegramId || !chatId) {
      return res.status(400).json({ error: 'telegramId and chatId are required' });
    }

    // Find existing or create new
    let telegramUser = await TelegramUser.findOne({ telegramId });

    if (!telegramUser) {
      telegramUser = new TelegramUser({
        telegramId,
        chatId,
        username,
        firstName,
        lastName,
      });
      await telegramUser.save();
    } else {
      // Update fields if changed
      if (chatId) telegramUser.chatId = chatId;
      if (username) telegramUser.username = username;
      if (firstName) telegramUser.firstName = firstName;
      if (lastName) telegramUser.lastName = lastName;
      await telegramUser.save();
    }

    res.json({
      telegramId: telegramUser.telegramId,
      chatId: telegramUser.chatId,
      username: telegramUser.username,
      firstName: telegramUser.firstName,
      lastName: telegramUser.lastName,
      isAuthenticated: telegramUser.isAuthenticated,
      conversationId: telegramUser.conversationId,
      sessionToken: telegramUser.sessionToken,
    });
  } catch (error) {
    console.error('Create/update telegram user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get telegram user by telegram ID
router.get('/users/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;

    const telegramUser = await TelegramUser.findOne({ telegramId });

    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    res.json({
      telegramId: telegramUser.telegramId,
      chatId: telegramUser.chatId,
      username: telegramUser.username,
      firstName: telegramUser.firstName,
      lastName: telegramUser.lastName,
      isAuthenticated: telegramUser.isAuthenticated,
      conversationId: telegramUser.conversationId,
      sessionToken: telegramUser.sessionToken,
      linkedAt: telegramUser.linkedAt,
    });
  } catch (error) {
    console.error('Get telegram user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create auth request for telegram user
router.post('/auth-request', async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }

    const telegramUser = await TelegramUser.findOne({ telegramId });

    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    // Generate auth token valid for 15 minutes
    const authToken = generateAuthToken();
    telegramUser.authToken = authToken;
    telegramUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await telegramUser.save();

    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const authUrl = `${process.env.API_BASE_URL || 'http://localhost:3001'}/telegram/verify?token=${authToken}`;

    res.json({
      authToken,
      authUrl,
      expiresAt: telegramUser.authTokenExpiry,
    });
  } catch (error) {
    console.error('Auth request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update conversation ID for telegram user
router.post('/users/:telegramId/conversation', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const { conversationId } = req.body;

    const telegramUser = await TelegramUser.findOne({ telegramId });

    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    telegramUser.conversationId = conversationId;
    await telegramUser.save();

    res.json({ success: true, conversationId });
  } catch (error) {
    console.error('Update conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout telegram user
router.post('/users/:telegramId/logout', async (req, res) => {
  try {
    const { telegramId } = req.params;

    const telegramUser = await TelegramUser.findOne({ telegramId });

    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    telegramUser.isAuthenticated = false;
    telegramUser.sessionToken = undefined;
    telegramUser.userId = undefined as any;
    telegramUser.conversationId = undefined;
    await telegramUser.save();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verification endpoint - redirects to app/web for authentication
router.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 1rem;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 10px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.1);
              text-align: center;
              max-width: 400px;
            }
            h1 { color: #333; margin: 0 0 1rem 0; }
            p { color: #666; line-height: 1.6; }
            .error { color: #e74c3c; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Invalid Token</h1>
            <p class="error">The authentication token is missing or invalid.</p>
            <p>Please request a new authentication link from the Telegram bot.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    // Find telegram user with this auth token
    const telegramUser = await TelegramUser.findOne({
      authToken: token.toUpperCase(),
      authTokenExpiry: { $gt: new Date() },
    });

    if (!telegramUser) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Authentication Failed</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 1rem;
              }
              .container {
                background: white;
                padding: 2rem;
                border-radius: 10px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.1);
                text-align: center;
                max-width: 400px;
              }
              h1 { color: #333; margin: 0 0 1rem 0; }
              p { color: #666; line-height: 1.6; }
              .error { color: #e74c3c; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>❌ Token Expired</h1>
              <p class="error">This authentication token has expired or does not exist.</p>
              <p>Please request a new authentication link from the Telegram bot.</p>
            </div>
          </body>
        </html>
      `);
    }

    // Redirect to app/web with token
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const redirectUrl = `${appUrl}/telegram-auth?token=${token.toUpperCase()}`;

    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Telegram verify error:', error);
    res.status(500).send('Internal server error');
  }
});

// Check if a token is valid (for app to verify before showing login)
router.get('/check-token/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Find telegram user with this auth token
    const telegramUser = await TelegramUser.findOne({
      authToken: token.toUpperCase(),
      authTokenExpiry: { $gt: new Date() },
    });

    if (!telegramUser) {
      return res.json({
        valid: false,
        error: 'Token not found or expired',
      });
    }

    res.json({
      valid: true,
      expiresAt: telegramUser.authTokenExpiry,
    });
  } catch (error) {
    console.error('Token check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link telegram account with authenticated user
router.post('/link', async (req, res) => {
  try {
    const { authToken, sessionToken } = req.body;

    if (!authToken || !sessionToken) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Find telegram user with this auth token
    const telegramUser = await TelegramUser.findOne({
      authToken: authToken.toUpperCase(),
      authTokenExpiry: { $gt: new Date() },
    });

    if (!telegramUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    // Verify the session token by making a request to /auth/me
    const meResponse = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    if (!meResponse.ok) {
      return res.status(401).json({ error: 'Invalid session token' });
    }

    const user = await meResponse.json();

    // Link the accounts
    telegramUser.userId = user._id || user.id;
    telegramUser.sessionToken = sessionToken;
    telegramUser.isAuthenticated = true;
    telegramUser.linkedAt = new Date();
    telegramUser.authToken = undefined;
    telegramUser.authTokenExpiry = undefined;
    await telegramUser.save();

    // Send confirmation message to Telegram
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken && telegramUser.chatId) {
        const userName = user.firstName || user.name || 'there';
        const message =
          `✅ <b>Authentication Successful!</b>\n\n` +
          `Welcome ${userName}! Your Telegram account is now linked to Alia.\n\n` +
          `You can start chatting with me right away. Just send me any message!`;

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });

        console.log('[Telegram] Sent authentication success message to user:', telegramUser.telegramId);
      }
    } catch (notifyError) {
      console.error('[Telegram] Failed to send notification:', notifyError);
      // Don't fail the request if notification fails
    }

    res.json({ success: true, message: 'Account linked successfully' });
  } catch (error) {
    console.error('Telegram link error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
