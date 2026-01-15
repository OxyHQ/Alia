import { Router } from 'express';
import { User } from '../models/user.js';
import { signToken } from '../lib/jwt.js';
import { authenticateToken } from '../middleware/auth.js';
import { z } from 'zod';

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

router.post('/forgot-password', async (req, res) => {
  // TODO: Implementar recuperación de contraseña
  res.status(501).json({ message: 'To be implemented' });
});

router.post('/reset-password', async (req, res) => {
  // TODO: Implementar reset de contraseña
  res.status(501).json({ message: 'To be implemented' });
});

export default router;
