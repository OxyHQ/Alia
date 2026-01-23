import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import { UserCredits } from '../models/user-credits.js';
import { Subscription } from '../models/subscription.js';
import { Transaction } from '../models/transaction.js';
import { z } from 'zod';

const router = Router();

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not defined');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-12-15.clover',
    });
  }
  return stripeInstance;
}

function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

// Helper to get or create UserCredits record
async function getOrCreateUserCredits(userId: string) {
  return UserCredits.findByIdAndUpdate(
    userId,
    {
      $setOnInsert: {
        _id: userId,
        credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
      },
    },
    { upsert: true, new: true }
  );
}

// Helper to get or create Stripe customer
async function getOrCreateStripeCustomer(userId: string, userCredits: any): Promise<string> {
  let customerId = userCredits.stripeCustomerId;

  if (customerId) {
    try {
      await getStripe().customers.retrieve(customerId);
      return customerId;
    } catch {
      customerId = null;
    }
  }

  // Fetch email from Oxy
  let email: string | undefined;
  try {
    const oxyUser = await oxyClient.getUserById(userId);
    email = oxyUser?.email;
  } catch (e) {
    console.error('[Billing] Failed to fetch user from Oxy:', e);
  }

  const customer = await getStripe().customers.create({
    email,
    metadata: { userId },
  });

  userCredits.stripeCustomerId = customer.id;
  await userCredits.save();
  console.log(`[Billing] Created Stripe customer ${customer.id} for user ${userId}`);

  return customer.id;
}

const CREDIT_PACKAGES = [
  { id: 'credits_1000', name: '1,000 Credits', credits: 1000, price: 500, currency: 'usd' },
  { id: 'credits_5000', name: '5,000 Credits', credits: 5000, price: 2000, currency: 'usd' },
  { id: 'credits_10000', name: '10,000 Credits', credits: 10000, price: 3500, currency: 'usd' },
  { id: 'credits_50000', name: '50,000 Credits', credits: 50000, price: 15000, currency: 'usd' },
];

const SUBSCRIPTION_PLANS = [
  { id: 'pro_monthly', name: 'Pro', creditsPerMonth: 10000, price: 2999, stripePriceId: process.env.STRIPE_PRO_PRICE_ID || '', currency: 'usd' },
  { id: 'business_monthly', name: 'Business', creditsPerMonth: 50000, price: 9999, stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID || '', currency: 'usd' },
];

router.get('/packages', async (_req: Request, res: Response) => {
  res.json({ packages: CREDIT_PACKAGES });
});

const createCheckoutSchema = z.object({
  packageId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/credits', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { packageId, successUrl, cancelUrl } = createCheckoutSchema.parse(req.body);
    const userId = req.user!.id;

    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package ID' });
    }

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: pkg.currency,
          product_data: { name: pkg.name, description: `${pkg.credits.toLocaleString()} AI credits` },
          unit_amount: pkg.price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: pkg.id, credits: pkg.credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('[Billing] Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/plans', async (_req: Request, res: Response) => {
  res.json({ plans: SUBSCRIPTION_PLANS });
});

const createSubscriptionSchema = z.object({
  planId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, successUrl, cancelUrl } = createSubscriptionSchema.parse(req.body);
    const userId = req.user!.id;

    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan || !plan.stripePriceId) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, planId: plan.id },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('[Billing] Error creating subscription checkout:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] },
    });
    res.json({ subscription });
  } catch (error: any) {
    console.error('[Billing] Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/subscription/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] },
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    res.json({ message: 'Subscription will be canceled at end of billing period', subscription });
  } catch (error: any) {
    console.error('[Billing] Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const transactions = await Transaction.find({ oxyUserId: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(offset));
    const total = await Transaction.countDocuments({ oxyUserId: req.user!.id });
    res.json({ transactions, total });
  } catch (error: any) {
    console.error('[Billing] Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/portal', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { returnUrl } = req.body;
    const userId = req.user!.id;

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('[Billing] Error creating portal session:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).send('Missing stripe-signature');

  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) return res.status(500).send('Webhook secret not configured');

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('[Billing] Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
    }
    res.json({ received: true });
  } catch (error: any) {
    console.error('[Billing] Error handling webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;
  if (!metadata?.userId || metadata.type !== 'credit_purchase') return;

  const credits = parseInt(metadata.credits || '0');
  if (credits <= 0) return;

  const userCredits = await getOrCreateUserCredits(metadata.userId);
  await userCredits.addCredits(credits, 'paid');
  console.log(`[Billing] Added ${credits} credits to user ${metadata.userId}`);

  await Transaction.create({
    oxyUserId: metadata.userId,
    stripeCustomerId: session.customer as string,
    stripePaymentIntentId: session.payment_intent as string,
    type: 'credit_purchase',
    amount: session.amount_total || 0,
    currency: session.currency || 'usd',
    credits,
    status: 'completed',
    description: `Purchased ${credits.toLocaleString()} credits`,
  });
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;
  const userCredits = await UserCredits.findOne({ stripeCustomerId: customerId });
  if (!userCredits) return;

  const plan = SUBSCRIPTION_PLANS.find((p) => p.stripePriceId === stripeSubscription.items.data[0].price.id);
  if (!plan) return;

  const sub = stripeSubscription as any;

  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: stripeSubscription.id },
    {
      oxyUserId: userCredits._id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: stripeSubscription.items.data[0].price.id,
      status: stripeSubscription.status,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      plan: { name: plan.name, creditsPerMonth: plan.creditsPerMonth, price: plan.price, currency: plan.currency },
    },
    { upsert: true, new: true }
  );

  if (stripeSubscription.status === 'active') {
    const now = Date.now() / 1000;
    if (Math.abs(now - sub.current_period_start) < 300) {
      await userCredits.addCredits(plan.creditsPerMonth, 'paid');
      await Transaction.create({
        oxyUserId: userCredits._id,
        stripeCustomerId: customerId,
        type: 'subscription_payment',
        amount: plan.price,
        currency: plan.currency,
        credits: plan.creditsPerMonth,
        status: 'completed',
        description: `${plan.name} subscription credits`,
      });
    }
  }
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: stripeSubscription.id },
    { status: 'canceled' }
  );
}

export default router;
