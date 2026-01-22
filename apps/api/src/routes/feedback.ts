import { Router } from 'express';
import { Feedback } from '../models/feedback.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

// All feedback routes require authentication
router.use(authenticateToken);

/**
 * POST /feedback
 * Submit new feedback
 */
router.post('/', async (req, res) => {
  try {
    const { type, rating, message, email, metadata } = req.body;

    if (!type || !message) {
      res.status(400).json({ error: 'Type and message are required' });
      return;
    }

    const validTypes = ['bug', 'feature', 'improvement', 'other'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: 'Invalid feedback type' });
      return;
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    const feedback = new Feedback({
      userId: req.user!.id,
      type,
      rating,
      message,
      email,
      metadata,
      status: 'pending'
    });

    await feedback.save();

    res.status(201).json({
      success: true,
      feedback: {
        id: feedback._id,
        type: feedback.type,
        message: feedback.message,
        createdAt: feedback.createdAt
      }
    });
  } catch (error) {
    console.error('Error submitting feedback:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

/**
 * GET /feedback
 * Get user's feedback history
 */
router.get('/', async (req, res) => {
  try {
    const feedback = await Feedback.find({ userId: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(feedback);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

/**
 * GET /feedback/:id
 * Get specific feedback by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const feedback = await Feedback.findOne({
      _id: req.params.id,
      userId: req.user!.id
    });

    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }

    res.json(feedback);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

export default router;
