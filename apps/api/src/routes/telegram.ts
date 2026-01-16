import express from 'express';
import { authenticateToken } from '../middleware/auth';
import mongoose from 'mongoose';

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

    res.json({ success: true, message: 'Account linked successfully' });
  } catch (error) {
    console.error('Telegram link error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
