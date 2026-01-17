import { Router } from 'express';
import { User } from '../models/user.js';
import { TelegramUser } from '../models/telegram-user.js';
import { signToken } from '../lib/jwt.js';
import { authenticateToken } from '../middleware/auth.js';
import { connectDB } from '../lib/db.js';
import { z } from 'zod';
import crypto from 'crypto';

const router = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/register
 * Register a new user with email and password
 */
router.post('/register', async (req, res) => {
  try {
    // Connect to database
    await connectDB();

    // Validate request body
    const validatedData = registerSchema.parse(req.body);

    // Check if user already exists
    const existingUser = await User.findOne({ email: validatedData.email.toLowerCase() });
    if (existingUser) {
      res.status(400).json({ error: 'User already exists with this email' });
      return;
    }

    // Create new user (password will be hashed by pre-save hook)
    const user = new User({
      email: validatedData.email.toLowerCase(),
      password: validatedData.password,
      name: {
        first: validatedData.firstName,
        last: validatedData.lastName,
      },
    });

    await user.save();

    // Generate JWT token
    const token = signToken({
      userId: user._id.toString(),
      email: user.email,
    });

    // Return user data (without password) and token
    res.status(201).json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
      },
      token,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Failed to register user' });
    }
  }
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
  try {
    // Connect to database
    await connectDB();

    // Validate request body
    const validatedData = loginSchema.parse(req.body);

    // Find user by email
    const user = await User.findOne({ email: validatedData.email.toLowerCase() });
    if (!user || !user.password) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Compare password using bcrypt
    const isPasswordValid = await user.comparePassword(validatedData.password);
    if (!isPasswordValid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Generate JWT token
    const token = signToken({
      userId: user._id.toString(),
      email: user.email,
    });

    // Return user data (without password) and token
    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
      },
      token,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
    } else {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Failed to login' });
    }
  }
});

/**
 * GET /api/auth/me
 * Get current user from JWT token
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // Connect to database
    await connectDB();

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Get full user data from database
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
        image: user.image,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * POST /api/auth/logout
 * Logout (client-side only, token invalidation handled by client)
 */
router.post('/logout', authenticateToken, async (req, res) => {
  // With JWT, logout is primarily client-side (remove token)
  // This endpoint exists for consistency and future enhancement (e.g., token blacklist)
  res.json({ message: 'Logged out successfully' });
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */
router.post('/forgot-password', async (req, res) => {
  try {
    // Connect to database
    await connectDB();

    // Validate request body
    const validatedData = forgotPasswordSchema.parse(req.body);

    // Find user by email
    const user = await User.findOne({ email: validatedData.email.toLowerCase() });

    // Always return success even if user doesn't exist (security best practice)
    if (!user) {
      res.json({ message: 'If that email is registered, you will receive a password reset link' });
      return;
    }

    // Generate reset token (valid for 1 hour)
    const crypto = await import('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    // Store hashed token and expiry in user document
    await User.findByIdAndUpdate(user._id, {
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: resetTokenExpiry,
    });

    // Create reset URL (in production, this would be your frontend URL)
    const resetUrl = `${process.env.WEB_URL || 'http://localhost:3000'}/(app)/reset-password?token=${resetToken}`;

    // TODO: In production, send email with resetUrl
    // For now, log to console
    console.log('\n=================================');
    console.log('PASSWORD RESET LINK:');
    console.log(resetUrl);
    console.log('=================================\n');

    res.json({ message: 'If that email is registered, you will receive a password reset link' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
    } else {
      console.error('Forgot password error:', error);
      res.status(500).json({ error: 'Failed to process password reset request' });
    }
  }
});

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
router.post('/reset-password', async (req, res) => {
  try {
    // Connect to database
    await connectDB();

    // Validate request body
    const validatedData = resetPasswordSchema.parse(req.body);

    // Hash the provided token
    const crypto = await import('crypto');
    const resetTokenHash = crypto.createHash('sha256').update(validatedData.token).digest('hex');

    // Find user with matching token and valid expiry
    const user = await User.findOne({
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    // Update password (will be hashed by pre-save hook)
    user.password = validatedData.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
    } else {
      console.error('Reset password error:', error);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
});

/**
 * POST /api/auth/telegram/initiate
 * Initiate Telegram sign-in flow
 * Returns an auth code that the bot will use to identify this session
 */
router.post('/telegram/initiate', async (req, res) => {
  try {
    await connectDB();

    // Generate a unique 6-character auth code for this sign-in attempt
    const authCode = crypto.randomBytes(3).toString('hex').toUpperCase();

    // Store this auth code temporarily in a pending state
    // We'll create a temporary TelegramUser entry that will be completed by the bot
    const pendingAuth = new TelegramUser({
      telegramId: `pending_${authCode}`, // Temporary ID
      chatId: 'pending',
      authToken: authCode,
      authTokenExpiry: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      authTokenMode: 'signin',
      isAuthenticated: false,
    });

    await pendingAuth.save();

    // Get bot username from environment
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'alia_ai_bot';

    // Create deep link for Telegram
    const deepLink = `https://t.me/${botUsername}?start=signin_${authCode}`;

    res.json({
      authCode,
      deepLink,
      expiresAt: pendingAuth.authTokenExpiry,
    });
  } catch (error) {
    console.error('Telegram initiate error:', error);
    res.status(500).json({ error: 'Failed to initiate Telegram sign-in' });
  }
});

/**
 * GET /api/auth/telegram/poll/:authCode
 * Poll endpoint for checking if Telegram sign-in is complete
 * The app calls this repeatedly to check if the user has authenticated via Telegram
 */
router.get('/telegram/poll/:authCode', async (req, res) => {
  try {
    await connectDB();

    const { authCode } = req.params;

    if (!authCode) {
      res.status(400).json({ error: 'Auth code is required' });
      return;
    }

    // Look for a TelegramUser with this auth code
    const telegramUser = await TelegramUser.findOne({
      authToken: authCode.toUpperCase(),
      authTokenMode: 'signin',
    });

    if (!telegramUser) {
      res.json({
        status: 'pending',
        message: 'Waiting for Telegram authentication',
      });
      return;
    }

    // Check if expired
    if (telegramUser.authTokenExpiry && telegramUser.authTokenExpiry < new Date()) {
      res.json({
        status: 'expired',
        message: 'Authentication code expired',
      });
      return;
    }

    // Check if authenticated
    if (telegramUser.isAuthenticated && telegramUser.sessionToken && telegramUser.userId) {
      // Sign-in complete! Return the session token
      res.json({
        status: 'completed',
        token: telegramUser.sessionToken,
      });
      return;
    }

    // Still pending
    res.json({
      status: 'pending',
      message: 'Waiting for Telegram authentication',
    });
  } catch (error) {
    console.error('Telegram poll error:', error);
    res.status(500).json({ error: 'Failed to check authentication status' });
  }
});

export default router;
