import express from 'express';
import { authenticateToken, authenticateTelegramBot } from '../middleware/auth.js';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { ChannelUser } from '../models/channel-user.js';
import { emitTelegramLinked } from '../socket.js';
import { OxyServices } from '@oxyhq/core';
import { isAliaModel, getAllAliaModels } from '../lib/chat-core.js';
import { log } from '../lib/logger.js';

// Initialize Oxy client for user lookups
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

const router = express.Router();

const CHANNEL_TYPE = 'telegram';

// Obtener info y modo de un token de Telegram
router.get('/users/token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });
    if (!channelUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }
    // Exponer solo los campos necesarios (sin email, ya que no existe en el modelo)
    res.json({
      telegramId: channelUser.channelUserId,
      authTokenMode: channelUser.authTokenMode,
      oxyUserId: channelUser.oxyUserId,
      sessionToken: channelUser.metadata?.sessionToken,
      name: channelUser.displayName || channelUser.username || '',
      isAuthenticated: channelUser.isAuthenticated,
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Token info (users/token) error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Telegram link status for authenticated user
router.get('/link-status', authenticateToken, async (req, res) => {
  try {
    const oxyUserId = req.userId; // From authenticateToken middleware

    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      isAuthenticated: true,
    });

    if (!channelUser) {
      return res.json({ linked: false });
    }

    res.json({
      linked: true,
      telegramUsername: channelUser.username,
      linkedAt: channelUser.linkedAt,
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Telegram link status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlink Telegram account for authenticated user
router.post('/unlink', authenticateToken, async (req, res) => {
  try {
    const oxyUserId = req.userId; // From authenticateToken middleware

    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      isAuthenticated: true,
    });

    if (!channelUser) {
      return res.status(404).json({ error: 'No linked Telegram account found' });
    }

    // Unlink the account but keep the channel user record
    channelUser.oxyUserId = undefined as any;
    channelUser.isAuthenticated = false;
    channelUser.conversationId = undefined;
    channelUser.linkedAt = undefined;
    await channelUser.save();

    // Optionally send notification to Telegram
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken && channelUser.chatId) {
        const message =
          `🔗 <b>Account Unlinked</b>\n\n` +
          `Your Telegram account has been unlinked from Oxy.\n\n` +
          `You can link it again anytime by using /start link`;

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channelUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });
      }
    } catch (notifyError) {
      log.telegram.error({ err: notifyError }, 'Failed to send unlink notification');
    }

    res.json({ success: true, message: 'Telegram account unlinked successfully' });
  } catch (error) {
    log.telegram.error({ err: error }, 'Telegram unlink error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to generate auth token
// Genera un token seguro de 32 bytes (64 caracteres hexadecimales)
function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Get or create telegram user
router.post('/users', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId, chatId, username, firstName, lastName } = req.body;

    if (!telegramId || !chatId) {
      return res.status(400).json({ error: 'telegramId and chatId are required' });
    }

    const displayName = [firstName, lastName].filter(Boolean).join(' ') || undefined;

    // Find existing or create new
    let channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (!channelUser) {
      channelUser = new ChannelUser({
        channelType: CHANNEL_TYPE,
        channelUserId: telegramId,
        chatId,
        username,
        displayName,
      });
      await channelUser.save();
    } else {
      // Update fields if changed
      if (chatId) channelUser.chatId = chatId;
      if (username) channelUser.username = username;
      if (displayName) channelUser.displayName = displayName;
      await channelUser.save();
    }

    res.json({
      telegramId: channelUser.channelUserId,
      chatId: channelUser.chatId,
      username: channelUser.username,
      firstName: channelUser.displayName?.split(' ')[0],
      lastName: channelUser.displayName?.split(' ').slice(1).join(' ') || undefined,
      isAuthenticated: channelUser.isAuthenticated,
      conversationId: channelUser.conversationId,
      sessionToken: channelUser.metadata?.sessionToken,
      preferredModel: channelUser.preferredModel,
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Create/update telegram user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get telegram user by telegram ID
router.get('/users/:telegramId', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.params;

    const channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    res.json({
      telegramId: channelUser.channelUserId,
      chatId: channelUser.chatId,
      username: channelUser.username,
      firstName: channelUser.displayName?.split(' ')[0],
      lastName: channelUser.displayName?.split(' ').slice(1).join(' ') || undefined,
      isAuthenticated: channelUser.isAuthenticated,
      oxyUserId: channelUser.oxyUserId,
      conversationId: channelUser.conversationId,
      sessionToken: channelUser.metadata?.sessionToken,
      linkedAt: channelUser.linkedAt,
      preferredModel: channelUser.preferredModel,
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Get telegram user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create auth request for login/registro con Telegram
router.post('/auth-request', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }
    let channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }
    // Generar token para login
    const authToken = generateAuthToken();
    channelUser.authToken = authToken;
    channelUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    channelUser.authTokenMode = 'signin';
    await channelUser.save();
    const authUrl = `${process.env.API_BASE_URL || 'http://localhost:3001'}/telegram/verify?token=${authToken}`;
    res.json({
      authToken,
      authUrl,
      expiresAt: channelUser.authTokenExpiry,
      mode: 'signin',
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Auth request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create link request para vincular Telegram a cuenta existente
router.post('/link-request', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }
    let channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }
    // Generar token para vinculación
    const authToken = generateAuthToken();
    channelUser.authToken = authToken;
    channelUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    channelUser.authTokenMode = 'link';
    await channelUser.save();
    const authUrl = `${process.env.API_BASE_URL || 'http://localhost:3001'}/telegram/verify?token=${authToken}`;
    res.json({
      authToken,
      authUrl,
      expiresAt: channelUser.authTokenExpiry,
      mode: 'link',
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Link request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update conversation ID for telegram user
router.post('/users/:telegramId/conversation', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.params;
    const { conversationId } = req.body;

    const channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    channelUser.conversationId = conversationId;
    await channelUser.save();

    res.json({ success: true, conversationId });
  } catch (error) {
    log.telegram.error({ err: error }, 'Update conversation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update preferred model for telegram user
router.post('/users/:telegramId/model', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.params;
    const { model } = req.body;

    if (!model || !(await isAliaModel(model))) {
      const allModels = (await getAllAliaModels()).map(m => m.id);
      return res.status(400).json({
        error: 'Invalid model',
        details: `Model must be one of: ${allModels.join(', ')}`
      });
    }

    const channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    channelUser.preferredModel = model;
    await channelUser.save();

    res.json({ success: true, model });
  } catch (error) {
    log.telegram.error({ err: error }, 'Update model error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout telegram user
router.post('/users/:telegramId/logout', authenticateTelegramBot, async (req, res) => {
  try {
    const { telegramId } = req.params;

    const channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (!channelUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }

    channelUser.isAuthenticated = false;
    channelUser.metadata = { ...channelUser.metadata, sessionToken: undefined };
    channelUser.oxyUserId = undefined as any;
    channelUser.conversationId = undefined;
    await channelUser.save();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    log.telegram.error({ err: error }, 'Logout error');
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
            <h1>Invalid Token</h1>
            <p class="error">The authentication token is missing or invalid.</p>
            <p>Please request a new authentication link from the Telegram bot.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    // Find channel user with this auth token
    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
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
              <h1>Token Expired</h1>
              <p class="error">This authentication token has expired or does not exist.</p>
              <p>Please request a new authentication link from the Telegram bot.</p>
            </div>
          </body>
        </html>
      `);
    }

    // Redirect to app/web with token
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const redirectUrl = `${appUrl}/telegram-auth?token=${token}`;

    res.redirect(redirectUrl);
  } catch (error) {
    log.telegram.error({ err: error }, 'Telegram verify error');
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

    // Find channel user with this auth token
    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
      return res.json({
        valid: false,
        error: 'Token not found or expired',
      });
    }

    res.json({
      valid: true,
      expiresAt: channelUser.authTokenExpiry,
    });
  } catch (error) {
    log.telegram.error({ err: error }, 'Token check error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link telegram account with authenticated user
router.post('/link', authenticateToken, async (req, res) => {
  try {
    const { authToken } = req.body;

    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const oxyUserId = req.userId; // From authenticateToken middleware
    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    // Find channel user with this auth token (solo modo link)
    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: authToken,
      authTokenExpiry: { $gt: new Date() },
      authTokenMode: 'link',
    });
    if (!channelUser) {
      return res.status(404).json({ error: 'Auth token not found, expired, or not for linking' });
    }

    // Get user info from Oxy
    let user: any;
    try {
      user = await oxyClient.getUserById(oxyUserId);
    } catch (error) {
      log.telegram.error({ err: error }, 'Failed to fetch user');
      return res.status(500).json({ error: 'Failed to fetch user information' });
    }

    // Link the accounts
    channelUser.oxyUserId = new mongoose.Types.ObjectId(oxyUserId);
    channelUser.isAuthenticated = true;
    channelUser.linkedAt = new Date();
    channelUser.authToken = undefined;
    channelUser.authTokenExpiry = undefined;
    if (req.accessToken) {
      channelUser.metadata = { ...channelUser.metadata, sessionToken: req.accessToken };
    }
    await channelUser.save();

    emitTelegramLinked(authToken, {
      oxyUserId: channelUser.oxyUserId,
      email: user.email,
      name: user.name?.full || user.name?.first || '',
      type: 'linked',
    });

    // Send confirmation message to Telegram
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        log.telegram.warn('Bot token not configured, skipping notification');
      } else if (!channelUser.chatId) {
        log.telegram.warn({ channelUserId: channelUser.channelUserId }, 'No chat ID for user');
      } else {
        // Use the user's name for the message
        const userName = user.name?.full || user.name?.first || channelUser.displayName || channelUser.username || '';
        const message =
          `✅ <b>¡Autenticación Exitosa!</b>\n\n` +
          `¡Bienvenido ${userName}! Tu cuenta de Telegram ahora está vinculada a Alia.\n\n` +
          `Puedes empezar a chatear conmigo ahora mismo. ¡Solo envíame cualquier mensaje! 💬`;

        log.telegram.info({ telegramId: channelUser.channelUserId, chatId: channelUser.chatId, userName }, 'Sending authentication success message');

        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: channelUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });

        const result = await response.json();
        if (!response.ok) {
          log.telegram.error({ err: result }, 'Failed to send message');
        } else {
          log.telegram.info({ channelUserId: channelUser.channelUserId }, 'Successfully sent authentication message');
        }
      }
    } catch (notifyError) {
      log.telegram.error({ err: notifyError }, 'Failed to send notification');
    }

    return res.json({ success: true });
  } catch (error) {
    log.telegram.error({ err: error }, 'Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete sign-in flow from Telegram bot
// NOTE: Account creation via Telegram is disabled. Users must sign in via Oxy first and then link their Telegram.
router.post('/signin-complete', authenticateTelegramBot, async (req, res) => {
  try {
    const { authCode, telegramId, chatId, username, firstName, lastName } = req.body;

    if (!authCode || !telegramId || !chatId) {
      log.telegram.error({ body: req.body }, 'Missing required fields in signin-complete');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const displayName = [firstName, lastName].filter(Boolean).join(' ') || undefined;

    // Find the pending auth request
    const pendingAuth = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: authCode,
      authTokenMode: 'signin',
      authTokenExpiry: { $gt: new Date() },
    });

    if (!pendingAuth) {
      log.telegram.error({ authCode }, 'Pending auth not found or expired');
      return res.status(404).json({ error: 'Auth code not found or expired' });
    }

    // Check if this Telegram user is already linked to an Oxy user
    let channelUser = await ChannelUser.findOne({ channelType: CHANNEL_TYPE, channelUserId: telegramId });

    if (channelUser && channelUser.oxyUserId) {
      // User has linked Telegram before - update their info and keep them authenticated
      channelUser.chatId = chatId;
      channelUser.username = username;
      channelUser.displayName = displayName;
      channelUser.isAuthenticated = true;
      channelUser.authToken = undefined;
      channelUser.authTokenExpiry = undefined;
      channelUser.authTokenMode = undefined;
      await channelUser.save();

      // Clean up pending auth if different
      if (pendingAuth._id.toString() !== channelUser._id.toString()) {
        await ChannelUser.deleteOne({ _id: pendingAuth._id });
      }

      // Fetch user data from Oxy
      try {
        const user = await oxyClient.getUserById(channelUser.oxyUserId.toString());
        log.telegram.info({ telegramId, oxyUserId: channelUser.oxyUserId }, 'Telegram user signed in with existing link');

        return res.json({
          success: true,
          isNewUser: false,
          user: {
            id: user._id,
            email: user.email,
            username: user.username,
            name: user.name,
          },
        });
      } catch (error) {
        log.telegram.error({ err: error, telegramId, oxyUserId: channelUser.oxyUserId }, 'Failed to fetch Oxy user');
        return res.status(404).json({ error: 'Linked Oxy user not found' });
      }
    } else {
      // Telegram not linked to any Oxy account - user must link via Oxy first
      // Update channel user info for future linking
      if (!channelUser) {
        channelUser = pendingAuth;
        channelUser.channelUserId = telegramId;
      }
      channelUser.chatId = chatId;
      channelUser.username = username;
      channelUser.displayName = displayName;
      channelUser.isAuthenticated = false;
      channelUser.authToken = undefined;
      channelUser.authTokenExpiry = undefined;
      channelUser.authTokenMode = undefined;
      await channelUser.save();

      // Clean up any duplicates
      await ChannelUser.deleteMany({ channelType: CHANNEL_TYPE, channelUserId: telegramId, _id: { $ne: channelUser._id } });

      log.telegram.info({ telegramId }, 'Telegram user not linked to Oxy account');
      return res.status(403).json({
        error: 'Telegram not linked to any account',
        message: 'Please sign in via Oxy and link your Telegram account first',
        requiresOxyAuth: true,
      });
    }
  } catch (error) {
    log.telegram.error({ err: error }, 'Telegram signin-complete error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint seguro para login automático con Telegram
router.get('/token-info/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    // Buscar channel user por token válido
    const channelUser = await ChannelUser.findOne({
      channelType: CHANNEL_TYPE,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
      authTokenMode: 'signin',
    });
    if (!channelUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }
    // Si ya está vinculado a un usuario Oxy y autenticado
    if (channelUser.oxyUserId && channelUser.isAuthenticated) {
      // Buscar datos del usuario en Oxy
      try {
        const user = await oxyClient.getUserById(channelUser.oxyUserId.toString());

        // Enviar mensaje de Telegram para notificar login
        try {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          if (botToken && channelUser.chatId) {
            const message =
              `🔑 <b>Inicio de sesión en Alia</b>\n\n` +
              `Tu cuenta de Telegram fue usada para iniciar sesión en Alia.\n` +
              `Si no fuiste tú, por favor contacta soporte.`;
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: channelUser.chatId,
                text: message,
                parse_mode: 'HTML',
              }),
            });
          }
        } catch (notifyError) {
          log.telegram.error({ err: notifyError }, 'Failed to send login notification');
        }

        // Compose full name from Oxy user
        const fullName = user.name
          ? [user.name.first, user.name.last].filter(Boolean).join(' ')
          : user.username || '';

        emitTelegramLinked(token, {
          oxyUserId: channelUser.oxyUserId,
          email: user.email,
          name: fullName,
        });

        return res.json({
          oxyUserId: channelUser.oxyUserId,
          email: user.email,
          username: user.username,
          name: fullName,
        });
      } catch (error) {
        log.telegram.error({ err: error }, 'Failed to fetch Oxy user');
        return res.status(404).json({ error: 'Linked Oxy user not found' });
      }
    }
    // No vinculado aún
    return res.status(404).json({ error: 'Telegram not linked to any account' });
  } catch (error) {
    log.telegram.error({ err: error }, 'Token info error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
