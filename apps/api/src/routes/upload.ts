import { Router, Request } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { uploadToS3, deleteFromS3 } from '../lib/s3.js';
import { User } from '../models/user.js';

const router = Router();

// Configure multer to store files in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

/**
 * POST /api/upload/avatar
 * Upload user avatar
 */
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req: Request, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Get user from database
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Delete old avatar from S3 if exists
    if (user.image) {
      await deleteFromS3(user.image);
    }

    // Upload new avatar to S3
    const avatarUrl = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      'avatars'
    );

    // Update user with new avatar URL
    user.image = avatarUrl;
    await user.save();

    res.json({
      message: 'Avatar uploaded successfully',
      avatarUrl,
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
        image: user.image,
      },
    });
  } catch (error: any) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload avatar' });
  }
});

/**
 * DELETE /api/upload/avatar
 * Delete user avatar
 */
router.delete('/avatar', authenticateToken, async (req: Request, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Delete avatar from S3
    if (user.image) {
      await deleteFromS3(user.image);
      user.image = undefined;
      await user.save();
    }

    res.json({
      message: 'Avatar deleted successfully',
      user: {
        id: user._id,
        email: user.email,
        name: user.name.full,
        image: user.image,
      },
    });
  } catch (error: any) {
    console.error('Avatar delete error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete avatar' });
  }
});

export default router;
