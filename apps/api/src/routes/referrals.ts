import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { Referral, getOrCreateReferral } from '../models/referral.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';

const router = Router();

const REFERRAL_CREDIT_REWARD = 500;
const BASE_URL = process.env.WEB_URL || 'https://alia.onl';

// Get current user's referral info (lazy-creates on first access)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const referral = await getOrCreateReferral(req.user!.id);

    res.json({
      inviteCode: referral.inviteCode,
      inviteUrl: `${BASE_URL}/invite/${referral.inviteCode}`,
      totalCreditsEarned: referral.totalCreditsEarned,
      totalReferrals: referral.totalReferrals,
    });
  } catch (error: any) {
    console.error('[Referrals] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Redeem an invite code
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) {
      return res.status(400).json({ error: 'inviteCode is required' });
    }

    const userId = req.user!.id;

    // Find the referrer by invite code
    const referrer = await Referral.findOne({ inviteCode });
    if (!referrer) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }

    // No self-referral
    if (referrer._id === userId) {
      return res.status(400).json({ error: 'Cannot redeem your own invite code' });
    }

    // Check if user was already referred
    const userReferral = await getOrCreateReferral(userId);
    if (userReferral.referredBy) {
      return res.status(400).json({ error: 'You have already redeemed an invite code' });
    }

    // Award credits to referred user
    const userCredits = await getOrCreateUserCredits(userId);
    await userCredits.addCredits(REFERRAL_CREDIT_REWARD, 'paid');

    // Award credits to referrer
    const referrerCredits = await getOrCreateUserCredits(referrer._id);
    await referrerCredits.addCredits(REFERRAL_CREDIT_REWARD, 'paid');

    // Update referrer's record
    await Referral.findByIdAndUpdate(referrer._id, {
      $push: {
        referredUsers: {
          userId,
          email: req.user!.email,
          creditedAt: new Date(),
          creditsAwarded: REFERRAL_CREDIT_REWARD,
        },
      },
      $inc: {
        totalCreditsEarned: REFERRAL_CREDIT_REWARD,
        totalReferrals: 1,
      },
    });

    // Mark the redeemed user as referred
    await Referral.findByIdAndUpdate(userId, {
      $set: { referredBy: referrer._id },
    });

    res.json({ success: true, creditsAwarded: REFERRAL_CREDIT_REWARD });
  } catch (error: any) {
    console.error('[Referrals] Redeem error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send invitation (returns mailto URL for client-side handling)
router.post('/send-invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const referral = await getOrCreateReferral(req.user!.id);
    const inviteUrl = `${BASE_URL}/invite/${referral.inviteCode}`;
    const subject = encodeURIComponent("You've been invited to Alia!");
    const body = encodeURIComponent(
      `Hey! I've been using Alia and thought you'd love it too. Sign up with my link and we both get ${REFERRAL_CREDIT_REWARD} credits:\n\n${inviteUrl}`
    );

    res.json({
      success: true,
      inviteUrl,
      mailtoUrl: `mailto:${email}?subject=${subject}&body=${body}`,
    });
  } catch (error: any) {
    console.error('[Referrals] Send invite error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get referral history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const referral = await getOrCreateReferral(req.user!.id);

    res.json({
      referrals: referral.referredUsers,
      total: referral.totalReferrals,
    });
  } catch (error: any) {
    console.error('[Referrals] History error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
