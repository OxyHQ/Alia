import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  findReferralByInviteCode,
  getOrCreateReferral,
  listRedemptions,
  redeemReferral,
} from '../db/notifications/referralRepository.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { addCredits } from '../db/billing/userCreditsRepository.js';
import { log } from '../lib/logger.js';
import { sanitizeMessage } from '../lib/errors/sanitize.js';

const router = Router();

const REFERRAL_CREDIT_REWARD = 500;
const BASE_URL = process.env.WEB_URL || 'https://alia.onl';
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

// Get current user's referral info (lazy-creates on first access)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const referral = await getOrCreateReferral(getDb(), req.user!.id);

    res.json({
      inviteCode: referral.inviteCode,
      inviteUrl: `${BASE_URL}/invite/${referral.inviteCode}`,
      totalCreditsEarned: referral.totalCreditsEarned,
      totalReferrals: referral.totalReferrals,
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch referrals') });
  }
});

/**
 * Redeem an invite code.
 *
 * The claim is taken BEFORE the money moves. Under Mongo this route granted
 * credits to both parties and only then recorded the referral, so two concurrent
 * redemptions by one account both passed the "already redeemed?" read and both
 * paid out — a race no Mongo constraint could close, because the guard lived in
 * a sub-document array. `redeemReferral` claims a `UNIQUE(referred_user_id)` row
 * first and reports whether it won; credits are granted only then.
 */
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode || typeof inviteCode !== 'string') {
      return res.status(400).json({ error: 'inviteCode is required' });
    }

    const userId = req.user!.id;

    // Find the referrer by invite code
    const referrer = await findReferralByInviteCode(getDb(), inviteCode);
    if (!referrer) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }

    // No self-referral
    if (referrer.id === userId) {
      return res.status(400).json({ error: 'Cannot redeem your own invite code' });
    }

    // The redeemer needs their own row before it can record who referred them.
    await getOrCreateReferral(getDb(), userId);

    const result = await redeemReferral(getDb(), {
      referrerId: referrer.id,
      referredUserId: userId,
      email: req.user!.email,
      creditsAwarded: REFERRAL_CREDIT_REWARD,
    });

    if (result.outcome === 'already_redeemed') {
      return res.status(400).json({ error: 'You have already redeemed an invite code' });
    }

    // Only now does the money move. `user_credits` is Postgres too now, but the
    // two grants below still sit OUTSIDE the transaction above: each is its own
    // atomic `credits = credits + n` statement, and a shared transaction here
    // would only be honest if a failed second grant rolled back the redemption
    // claim — which would then be re-redeemable. The durable claim commits first
    // and stays committed; that is the deliberate ordering, not an artefact of
    // two stores.
    const userCredits = await getOrCreateUserCredits(userId);
    await addCredits(getDb(), userCredits.id, REFERRAL_CREDIT_REWARD, 'paid');

    // Award credits to referrer
    const referrerCredits = await getOrCreateUserCredits(referrer.id);
    await addCredits(getDb(), referrerCredits.id, REFERRAL_CREDIT_REWARD, 'paid');

    res.json({ success: true, creditsAwarded: REFERRAL_CREDIT_REWARD });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Redeem error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to redeem invite code') });
  }
});

// Send invitation (returns mailto URL for client-side handling)
router.post('/send-invite', authenticateToken, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const referral = await getOrCreateReferral(getDb(), req.user!.id);
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
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Send invite error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to send invite') });
  }
});

/**
 * Get referral history.
 *
 * `referredUsers` was a sub-document array on the referral; it is now a child
 * table, so the shape is preserved by mapping the rows back rather than by
 * storing them nested. `total` still comes from the stored counter, which is the
 * source's behaviour — the two must never be summed together.
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const referral = await getOrCreateReferral(getDb(), req.user!.id);
    const redemptions = await listRedemptions(getDb(), referral.id);

    res.json({
      referrals: redemptions.map((r) => ({
        userId: r.referredUserId,
        email: r.email ?? undefined,
        creditedAt: r.creditedAt,
        creditsAwarded: r.creditsAwarded,
      })),
      total: referral.totalReferrals,
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'History error');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch referral history') });
  }
});

export default router;
