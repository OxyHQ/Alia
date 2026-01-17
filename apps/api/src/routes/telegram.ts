import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
import { TelegramUser } from '../models/telegram-user.js';
import { User } from '../models/user.js';
import { emitTelegramLinked } from '../socket.js';
import { signToken } from '../lib/jwt.js';

const router = express.Router();

// Obtener info y modo de un token de Telegram
router.get('/users/token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    const telegramUser = await TelegramUser.findOne({
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });
    if (!telegramUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }
    // Exponer solo los campos necesarios (sin email, ya que no existe en el modelo)
    res.json({
      telegramId: telegramUser.telegramId,
      authTokenMode: telegramUser.authTokenMode,
      userId: telegramUser.userId,
      sessionToken: telegramUser.sessionToken,
      name: telegramUser.firstName || telegramUser.username || '',
      isAuthenticated: telegramUser.isAuthenticated,
    });
  } catch (error) {
    console.error('Token info (users/token) error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Helper to generate auth token
// Genera un token seguro de 32 bytes (64 caracteres hexadecimales)
function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
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

// Create auth request for login/registro con Telegram
router.post('/auth-request', async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }
    let telegramUser = await TelegramUser.findOne({ telegramId });
    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }
    // Generar token para login
    const authToken = generateAuthToken();
    telegramUser.authToken = authToken;
    telegramUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    telegramUser.authTokenMode = 'signin';
    await telegramUser.save();
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const authUrl = `${process.env.API_BASE_URL || 'http://localhost:3001'}/telegram/verify?token=${authToken}`;
    res.json({
      authToken,
      authUrl,
      expiresAt: telegramUser.authTokenExpiry,
      mode: 'signin',
    });
  } catch (error) {
    console.error('Auth request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create link request para vincular Telegram a cuenta existente
router.post('/link-request', async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) {
      return res.status(400).json({ error: 'telegramId is required' });
    }
    let telegramUser = await TelegramUser.findOne({ telegramId });
    if (!telegramUser) {
      return res.status(404).json({ error: 'Telegram user not found' });
    }
    // Generar token para vinculación
    const authToken = generateAuthToken();
    telegramUser.authToken = authToken;
    telegramUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    telegramUser.authTokenMode = 'link';
    await telegramUser.save();
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const authUrl = `${process.env.API_BASE_URL || 'http://localhost:3001'}/telegram/verify?token=${authToken}`;
    res.json({
      authToken,
      authUrl,
      expiresAt: telegramUser.authTokenExpiry,
      mode: 'link',
    });
  } catch (error) {
    console.error('Link request error:', error);
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
        authToken: token,
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
      const redirectUrl = `${appUrl}/telegram-auth?token=${token}`;

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
        authToken: token,
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

    // Find telegram user with this auth token (solo modo link)
    const telegramUser = await TelegramUser.findOne({
      authToken: authToken,
      authTokenExpiry: { $gt: new Date() },
      authTokenMode: 'link',
    });
    if (!telegramUser) {
      return res.status(404).json({ error: 'Auth token not found, expired, or not for linking' });
    }

    // Verify the session token by making a request to /auth/me
    const meResponse = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    if (!meResponse.ok) {
      return res.status(401).json({ error: 'Invalid session token' });
    }

      const meData: any = await meResponse.json();
    const user = meData.user || meData; // Handle nested user object

    // Link the accounts
    telegramUser.userId = user._id || user.id;
    telegramUser.sessionToken = sessionToken;
    telegramUser.isAuthenticated = true;
    telegramUser.linkedAt = new Date();
    telegramUser.authToken = undefined;
    telegramUser.authTokenExpiry = undefined;
    await telegramUser.save();

    emitTelegramLinked(req.body.authToken, {
      userId: telegramUser.userId,
      sessionToken: telegramUser.sessionToken,
      email: user.email,
      name: user.name?.full || user.name?.first || '',
      type: 'linked',
    });

    // Send confirmation message to Telegram
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        console.warn('[Telegram] Bot token not configured, skipping notification');
      } else if (!telegramUser.chatId) {
        console.warn('[Telegram] No chat ID for user:', telegramUser.telegramId);
      } else {
        // Use the user's name for the message
        const userName = user.name?.full || user.name?.first || telegramUser.firstName || telegramUser.username || '';
        const message =
          `✅ <b>¡Autenticación Exitosa!</b>\n\n` +
          `¡Bienvenido ${userName}! Tu cuenta de Telegram ahora está vinculada a Alia.\n\n` +
          `Puedes empezar a chatear conmigo ahora mismo. ¡Solo envíame cualquier mensaje! 💬`;

        console.log('[Telegram] Sending authentication success message to:', {
          telegramId: telegramUser.telegramId,
          chatId: telegramUser.chatId,
          userName
        });

        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });

        const result = await response.json();
        if (!response.ok) {
          console.error('[Telegram] Failed to send message:', result);
        } else {
          console.log('[Telegram] Successfully sent authentication message to user:', telegramUser.telegramId);
        }
      }
    } catch (notifyError) {
      console.error('[Telegram] Failed to send notification:', notifyError);
    }
  } catch (notifyError) {
    console.error('[Telegram] Failed to send notification:', notifyError);
  }
});

// Complete sign-in flow from Telegram bot
router.post('/signin-complete', async (req, res) => {
  try {
    const { authCode, telegramId, chatId, username, firstName, lastName } = req.body;

    if (!authCode || !telegramId || !chatId) {
      console.error('[signin-complete] Missing required fields', req.body);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Find the pending auth request
    const pendingAuth = await TelegramUser.findOne({
      authToken: authCode,
      authTokenMode: 'signin',
      authTokenExpiry: { $gt: new Date() },
    });

    if (!pendingAuth) {
      console.error('[signin-complete] Pending auth not found or expired', { authCode });
      return res.status(404).json({ error: 'Auth code not found or expired' });
    }

    // Always update the TelegramUser for this telegramId (never create duplicates)
    let telegramUser = await TelegramUser.findOne({ telegramId });
    let isNewUser = false;
    let user;

    if (telegramUser && telegramUser.userId) {
      // User has signed in with Telegram before - log them in
      user = await User.findById(telegramUser.userId);
      if (!user) {
        console.error('[signin-complete] Linked user not found', { telegramId, userId: telegramUser.userId });
        return res.status(404).json({ error: 'Linked user not found' });
      }
    } else {
      // New user - create account from Telegram profile
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || username || 'Telegram User';
      const nameParts = displayName.split(' ');
      user = new User({
        email: `telegram_${telegramId}@temp.alia.onl`, // Temporary email
        name: {
          first: nameParts[0] || 'User',
          last: nameParts.slice(1).join(' ') || undefined,
        },
      });
      await user.save();
      isNewUser = true;
    }

    // Generate session token
    const sessionToken = signToken({
      userId: user._id.toString(),
      email: user.email,
    });

    // Update the TelegramUser (always the one for this telegramId)
    if (!telegramUser) {
      telegramUser = pendingAuth;
      telegramUser.telegramId = telegramId;
    }
    telegramUser.chatId = chatId;
    telegramUser.username = username;
    telegramUser.firstName = firstName;
    telegramUser.lastName = lastName;
    telegramUser.userId = user._id;
    telegramUser.sessionToken = sessionToken;
    telegramUser.isAuthenticated = true;
    telegramUser.linkedAt = new Date();
    telegramUser.authToken = undefined;
    telegramUser.authTokenExpiry = undefined;
    telegramUser.authTokenMode = undefined;
    await telegramUser.save();

    // Remove any duplicate TelegramUser entries for this telegramId except the current one
    await TelegramUser.deleteMany({ telegramId, _id: { $ne: telegramUser._id } });

    console.log('[signin-complete] Telegram user updated and signed in', { telegramId, userId: user._id });
    res.json({
      success: true,
      isNewUser,
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
      },
    });
  } catch (error) {
    console.error('Telegram signin-complete error:', error);
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
    // Buscar usuario de Telegram por token válido
        const telegramUser = await TelegramUser.findOne({
          authToken: token,
          authTokenExpiry: { $gt: new Date() },
          authTokenMode: 'signin',
        });
    if (!telegramUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }
    // Si ya está vinculado a un usuario y tiene sessionToken válido
    if (telegramUser.userId && telegramUser.sessionToken && telegramUser.isAuthenticated) {
      // Buscar datos mínimos del usuario
      const user = await User.findById(telegramUser.userId);
      // Enviar mensaje de Telegram para notificar login (opcional, solo si no se ha notificado recientemente)
      try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken && telegramUser.chatId) {
          const message =
            `🔑 <b>Inicio de sesión en Alia</b>\n\n` +
            `Tu cuenta de Telegram fue usada para iniciar sesión en Alia.\n` +
            `Si no fuiste tú, por favor contacta soporte.`;
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramUser.chatId,
              text: message,
              parse_mode: 'HTML',
            }),
          });
        }
      } catch (notifyError) {
        console.error('[Telegram] Failed to send login notification:', notifyError);
      }
      // Compose full name safely
      let fullName = '';
      if (user?.name) {
        if ('full' in user.name && typeof user.name.full === 'string') {
          fullName = user.name.full;
        } else {
          const parts = [user.name.first, user.name.middle, user.name.last].filter(Boolean);
          fullName = parts.join(' ');
        }
      }
      emitTelegramLinked(token, {
        userId: telegramUser.userId,
        sessionToken: telegramUser.sessionToken,
        email: user?.email,
        name: fullName,
      });
      return res.json({
        userId: telegramUser.userId,
        sessionToken: telegramUser.sessionToken,
        email: user?.email,
        name: fullName,
      });
    }
    // No vinculado aún
    return res.status(404).json({ error: 'Telegram not linked to any account' });
  } catch (error) {
    console.error('Token info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
