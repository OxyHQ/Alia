import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken } from '../middleware/auth';
import { User } from '../models/user';
import { Subscription } from '../models/subscription';
import { Transaction } from '../models/transaction';
import { z } from 'zod';

const router = Router();

// Lazy initialize Stripe
let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not defined in environment variables');
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

// Credit packages
const CREDIT_PACKAGES = [
  {
    id: 'credits_1000',
    name: '1,000 Credits',
    credits: 1000,
    price: 500, // $5.00 in cents
    currency: 'usd',
  },
  {
    id: 'credits_5000',
    name: '5,000 Credits',
    credits: 5000,
    price: 2000, // $20.00 in cents (20% discount)
    currency: 'usd',
  },
  {
    id: 'credits_10000',
    name: '10,000 Credits',
    credits: 10000,
    price: 3500, // $35.00 in cents (30% discount)
    currency: 'usd',
  },
  {
    id: 'credits_50000',
    name: '50,000 Credits',
    credits: 50000,
    price: 15000, // $150.00 in cents (40% discount)
    currency: 'usd',
  },
];

// Subscription plans
const SUBSCRIPTION_PLANS = [
  {
    id: 'pro_monthly',
    name: 'Pro',
    creditsPerMonth: 10000,
    price: 2999, // $29.99 in cents
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID || '',
    currency: 'usd',
  },
  {
    id: 'business_monthly',
    name: 'Business',
    creditsPerMonth: 50000,
    price: 9999, // $99.99 in cents
    stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID || '',
    currency: 'usd',
  },
];

// ===========================================
// CREDIT PURCHASE ROUTES
// ===========================================

// Get available credit packages
router.get('/packages', async (req: Request, res: Response) => {
  try {
    res.json({ packages: CREDIT_PACKAGES });
  } catch (error: any) {
    console.error('[Billing] Error fetching packages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create checkout session for credit purchase
const createCheckoutSchema = z.object({
  packageId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/credits', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { packageId, successUrl, cancelUrl } = createCheckoutSchema.parse(req.body);
    const userId = req.user!.id;

    // Find the package
    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package ID' });
    }

    // Get or create Stripe customer
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: user.email,
        metadata: { userId: userId.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // Create checkout session
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: pkg.currency,
            product_data: {
              name: pkg.name,
              description: `${pkg.credits.toLocaleString()} AI credits`,
            },
            unit_amount: pkg.price,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: userId.toString(),
        type: 'credit_purchase',
        packageId: pkg.id,
        credits: pkg.credits.toString(),
      },
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

// ===========================================
// SUBSCRIPTION ROUTES
// ===========================================

// Get available subscription plans
router.get('/plans', async (req: Request, res: Response) => {
  try {
    res.json({ plans: SUBSCRIPTION_PLANS });
  } catch (error: any) {
    console.error('[Billing] Error fetching plans:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create checkout session for subscription
const createSubscriptionSchema = z.object({
  planId: z.string(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, successUrl, cancelUrl } = createSubscriptionSchema.parse(req.body);
    const userId = req.user!.id;

    // Find the plan
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan || !plan.stripePriceId) {
      return res.status(400).json({ error: 'Invalid plan ID or plan not configured' });
    }

    // Get or create Stripe customer
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: user.email,
        metadata: { userId: userId.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // Create checkout session
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: userId.toString(),
        planId: plan.id,
      },
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

// Get user's current subscription
router.get('/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['active', 'trialing'] },
    });

    res.json({ subscription });
  } catch (error: any) {
    console.error('[Billing] Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel subscription
router.post('/subscription/cancel', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['active', 'trialing'] },
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel at period end
    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    res.json({ message: 'Subscription will be canceled at the end of the billing period', subscription });
  } catch (error: any) {
    console.error('[Billing] Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// TRANSACTION HISTORY
// ===========================================

// Get transaction history
router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { limit = 20, offset = 0 } = req.query;

    const transactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(offset));

    const total = await Transaction.countDocuments({ userId });

    res.json({ transactions, total });
  } catch (error: any) {
    console.error('[Billing] Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// CUSTOMER PORTAL
// ===========================================

// Create portal session
router.post('/portal', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { returnUrl } = req.body;

    const user = await User.findById(userId);
    if (!user || !user.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('[Billing] Error creating portal session:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// WEBHOOKS
// ===========================================

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  if (!sig) {
    console.error('[Billing] No Stripe signature in request headers');
    return res.status(400).send('Webhook Error: Missing stripe-signature header');
  }

  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    console.error('[Billing] STRIPE_WEBHOOK_SECRET is not configured');
    console.error('[Billing] Please set STRIPE_WEBHOOK_SECRET in your .env file');
    console.error('[Billing] You can get this from your Stripe Dashboard > Developers > Webhooks');
    return res.status(500).send('Webhook Error: Webhook secret not configured');
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log(`[Billing] Received webhook event: ${event.type}`);
  } catch (err: any) {
    console.error('[Billing] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(`[Billing] Processing checkout.session.completed for session ${session.id}`);
        await handleCheckoutCompleted(session);
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`[Billing] Processing payment_intent.succeeded for ${paymentIntent.id}`);
        await handlePaymentSucceeded(paymentIntent);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log(`[Billing] Processing ${event.type} for subscription ${subscription.id}`);
        await handleSubscriptionUpdate(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log(`[Billing] Processing customer.subscription.deleted for ${subscription.id}`);
        await handleSubscriptionDeleted(subscription);
        break;
      }

      default:
        console.log(`[Billing] Unhandled event type: ${event.type}`);
    }

    console.log(`[Billing] Successfully processed webhook event: ${event.type}`);
    res.json({ received: true });
  } catch (error: any) {
    console.error('[Billing] Error handling webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// WEBHOOK HANDLERS
// ===========================================

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  console.log(`[Billing] handleCheckoutCompleted called for session ${session.id}`);

  const metadata = session.metadata;
  if (!metadata) {
    console.log('[Billing] No metadata found in checkout session');
    return;
  }

  if (!metadata.userId) {
    console.log('[Billing] No userId in metadata');
    return;
  }

  const userId = metadata.userId;
  console.log(`[Billing] Processing checkout for user ${userId}`);
  console.log(`[Billing] Metadata:`, metadata);

  // Handle credit purchase
  if (metadata.type === 'credit_purchase') {
    const credits = parseInt(metadata.credits || '0');
    console.log(`[Billing] Credit purchase detected: ${credits} credits`);

    if (credits > 0) {
      const user = await User.findById(userId);
      if (!user) {
        console.error(`[Billing] User ${userId} not found`);
        return;
      }

      console.log(`[Billing] Adding ${credits} paid credits to user ${user.email}`);
      await user.addCredits(credits, 'paid');
      console.log(`[Billing] Credits added successfully. New paid credits: ${user.credits.paid}`);

      // Create transaction record
      const transaction = await Transaction.create({
        userId,
        stripeCustomerId: session.customer as string,
        stripePaymentIntentId: session.payment_intent as string,
        type: 'credit_purchase',
        amount: session.amount_total || 0,
        currency: session.currency || 'usd',
        credits,
        status: 'completed',
        description: `Purchased ${credits.toLocaleString()} credits`,
      });
      console.log(`[Billing] Transaction record created: ${transaction._id}`);
    } else {
      console.log('[Billing] Credits amount is 0 or invalid');
    }
  } else {
    console.log(`[Billing] Not a credit purchase, type is: ${metadata.type}`);
  }
}

async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  // Additional payment success handling if needed
  console.log('[Billing] Payment succeeded:', paymentIntent.id);
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;
  const user = await User.findOne({ stripeCustomerId: customerId });
  if (!user) return;

  const plan = SUBSCRIPTION_PLANS.find((p) => p.stripePriceId === stripeSubscription.items.data[0].price.id);
  if (!plan) return;

  // Type assertion for subscription properties
  const sub = stripeSubscription as any;

  // Update or create subscription record
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: stripeSubscription.id },
    {
      userId: user._id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: stripeSubscription.items.data[0].price.id,
      status: stripeSubscription.status,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      plan: {
        name: plan.name,
        creditsPerMonth: plan.creditsPerMonth,
        price: plan.price,
        currency: plan.currency,
      },
    },
    { upsert: true, new: true }
  );

  // If subscription is active and at the start of a new period, add credits
  if (stripeSubscription.status === 'active') {
    const now = Date.now() / 1000;
    const periodStart = sub.current_period_start;

    // If we're within 5 minutes of period start, add the credits
    if (Math.abs(now - periodStart) < 300) {
      await user.addCredits(plan.creditsPerMonth, 'paid');

      await Transaction.create({
        userId: user._id,
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
