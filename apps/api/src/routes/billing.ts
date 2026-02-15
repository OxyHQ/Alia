import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import { UserCredits } from '../models/user-credits.js';
import { Subscription } from '../models/subscription.js';
import { Transaction } from '../models/transaction.js';
import { Plan } from '../internal/providers/models/plan.js';
import { CreditPackage } from '../internal/providers/models/credit-package.js';
import { AliaModel as AliaModelDB } from '../internal/providers/models/alia-model.js';
import { Feature } from '../internal/providers/models/feature.js';
import { PlanFeature } from '../internal/providers/models/plan-feature.js';
import { ALIA_MODELS } from '../internal/providers/lib/alia-models.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { getUserEntitlements, invalidateEntitlementsCache } from '../lib/plan-access.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';

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
    log.credits.error({ err: e }, 'Failed to fetch user from Oxy');
  }

  const customer = await getStripe().customers.create({
    email,
    metadata: { userId },
  });

  userCredits.stripeCustomerId = customer.id;
  await userCredits.save();
  log.credits.info({ customerId: customer.id, userId }, 'Created Stripe customer');

  return customer.id;
}

// Legacy plan ID mapping for existing Stripe subscriptions
const LEGACY_PLAN_MAP: Record<string, string> = {
  basic: 'go',
  standard: 'pro',
};

router.get('/packages', async (_req: Request, res: Response) => {
  try {
    const packages = await CreditPackage.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    res.json({
      packages: packages.map(p => ({
        id: p.packageId,
        name: p.name,
        credits: p.credits,
        price: p.price,
        currency: p.currency,
      })),
    });
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error fetching packages');
    res.status(500).json({ error: error.message });
  }
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

    const pkg = await CreditPackage.findOne({ packageId, isActive: true }).lean();
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package ID' });
    }

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const lineItem = pkg.stripePriceId
      ? { price: pkg.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: pkg.currency,
            product_data: { name: pkg.name, description: `${pkg.credits.toLocaleString()} AI credits` },
            unit_amount: pkg.price,
          },
          quantity: 1,
        };

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: 'payment',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: pkg.packageId, credits: pkg.credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating checkout session');
    res.status(500).json({ error: error.message });
  }
});

// Custom credit amount purchase
const CREDIT_PRICE_PER_1K_CENTS = 1000; // $10.00 per 1,000 credits
const MIN_CUSTOM_CREDITS = 100;
const MAX_CUSTOM_CREDITS = 1_000_000;

const customCreditsSchema = z.object({
  credits: z.number().int().min(MIN_CUSTOM_CREDITS).max(MAX_CUSTOM_CREDITS),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/custom-credits', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { credits, successUrl, cancelUrl } = customCreditsSchema.parse(req.body);
    const userId = req.user!.id;

    // Use best per-credit rate from active packages, fall back to constant
    const packages = await CreditPackage.find({ isActive: true }).lean();
    let pricePerCredit = CREDIT_PRICE_PER_1K_CENTS / 1000;
    if (packages.length > 0) {
      pricePerCredit = Math.min(...packages.map(p => p.price / p.credits));
    }

    const totalCents = Math.round(credits * pricePerCredit);
    if (totalCents < 50) {
      return res.status(400).json({ error: 'Minimum purchase amount is $0.50' });
    }

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${credits.toLocaleString()} AI Credits`, description: 'Custom credit purchase' },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, type: 'credit_purchase', packageId: 'custom', credits: credits.toString() },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating custom credits checkout');
    res.status(500).json({ error: error.message });
  }
});

// Expose the per-credit rate so the frontend can show live pricing
router.get('/credit-price', async (_req: Request, res: Response) => {
  try {
    const packages = await CreditPackage.find({ isActive: true }).lean();
    let pricePerCredit = CREDIT_PRICE_PER_1K_CENTS / 1000;
    if (packages.length > 0) {
      pricePerCredit = Math.min(...packages.map(p => p.price / p.credits));
    }
    res.json({ pricePerCreditCents: pricePerCredit, minCredits: MIN_CUSTOM_CREDITS, maxCredits: MAX_CUSTOM_CREDITS });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const query: any = { isActive: true };
    if (product) query.product = product;

    const [dbPlans, allFeatures, allPlanFeatures] = await Promise.all([
      Plan.find(query).sort({ sortOrder: 1 }).lean(),
      Feature.find({ isActive: true, isVisibleOnPricing: true }).sort({ category: 1, sortOrder: 1 }).lean(),
      PlanFeature.find({ enabled: true }).lean(),
    ]);

    // Build lookup: planId -> featureId -> PlanFeature mapping
    const pfMap: Record<string, Record<string, any>> = {};
    for (const pf of allPlanFeatures) {
      if (!pfMap[pf.planId]) pfMap[pf.planId] = {};
      pfMap[pf.planId][pf.featureId] = pf;
    }

    // Load all active Alia models from DB, fall back to hardcoded
    let modelMap: Record<string, { displayName: string; description?: string }> = {};
    try {
      const dbModels = await AliaModelDB.find({ isActive: true }).lean();
      if (dbModels.length > 0) {
        for (const m of dbModels) modelMap[m.aliasModelId] = { displayName: m.displayName, description: m.description };
      }
    } catch { /* ignore */ }
    for (const [id, m] of Object.entries(ALIA_MODELS)) {
      if (!modelMap[id]) modelMap[id] = { displayName: m.name, description: m.description };
    }

    const plans = dbPlans.map(p => {
      const planId = (p as any).planId;
      const planMappings = pfMap[planId] || {};

      // Build feature groups from Feature + PlanFeature collections
      const groupMap = new Map<string, { label: string; description?: string }[]>();

      for (const feat of allFeatures) {
        const mapping = planMappings[feat.featureId];
        if (!mapping) continue;

        const category = feat.category;
        if (!groupMap.has(category)) groupMap.set(category, []);

        groupMap.get(category)!.push({
          label: mapping.displayLabel || feat.label,
          description: mapping.displayDescription || feat.description,
        });
      }

      // Convert to array, preserving category order from features query
      const features: { category: string; items: { label: string; description?: string }[] }[] = [];
      const seenCategories = new Set<string>();
      for (const feat of allFeatures) {
        if (seenCategories.has(feat.category)) continue;
        const items = groupMap.get(feat.category);
        if (items && items.length > 0) {
          features.push({ category: feat.category, items });
          seenCategories.add(feat.category);
        }
      }

      // Insert "Models" group from modelIds (after Credits if present, else at start)
      const modelIds: string[] = (p as any).modelIds || [];
      if (modelIds.length > 0) {
        const modelItems = modelIds
          .map(id => modelMap[id])
          .filter(Boolean)
          .map(m => ({ label: m!.displayName, description: m!.description }));

        if (modelItems.length > 0) {
          const insertAt = features.length > 0 && features[0].category === 'Credits' ? 1 : 0;
          features.splice(insertAt, 0, { category: 'Models', items: modelItems });
        }
      }

      return {
        id: planId,
        name: p.name,
        product: p.product,
        creditsPerMonth: p.creditsPerMonth,
        monthlyPrice: p.monthlyPrice,
        annualPrice: p.annualPrice,
        currency: p.currency,
        features,
        subtitle: p.subtitle,
        creditsLabel: p.creditsLabel,
        isFeatured: p.isFeatured,
        isFree: p.isFree,
      };
    });
    res.json({ plans });
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error fetching plans');
    res.status(500).json({ error: error.message });
  }
});

const createSubscriptionSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

router.post('/checkout/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod, successUrl, cancelUrl } = createSubscriptionSchema.parse(req.body);
    const userId = req.user!.id;

    const plan = await Plan.findOne({ planId, isActive: true, isFree: false }).lean();
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const existingSubscription = await Subscription.findOne({
      oxyUserId: userId,
      'plan.product': plan.product,
      status: { $in: ['active', 'trialing'] },
    }).lean();

    if (existingSubscription) {
      return res.status(409).json({
        error: 'You already have an active subscription for this product. Please cancel it first or manage it from the billing page.',
      });
    }

    const userCredits = await getOrCreateUserCredits(userId);
    const customerId = await getOrCreateStripeCustomer(userId, userCredits);

    const isAnnual = billingPeriod === 'annual';
    const stripePriceId = isAnnual ? plan.stripeAnnualPriceId : plan.stripeMonthlyPriceId;

    const lineItem = stripePriceId
      ? { price: stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: plan.currency,
            product_data: { name: `${plan.name} Plan (${isAnnual ? 'Annual' : 'Monthly'})` },
            unit_amount: isAnnual ? plan.annualPrice : plan.monthlyPrice,
            recurring: { interval: isAnnual ? ('year' as const) : ('month' as const) },
          },
          quantity: 1,
        };

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [lineItem],
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product },
      subscription_data: { metadata: { userId, planId: plan.planId, billingPeriod, product: plan.product } },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating subscription checkout');
    res.status(500).json({ error: error.message });
  }
});

router.get('/subscription', authenticateToken, async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const query: any = {
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] },
    };
    if (product) {
      query['plan.product'] = product;
    }
    const subscription = await Subscription.findOne(query).lean();
    res.json({ subscription });
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error fetching subscription');
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
    log.credits.error({ err: error }, 'Error canceling subscription');
    res.status(500).json({ error: error.message });
  }
});

router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const transactions = await Transaction.find({ oxyUserId: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(offset))
      .lean();
    const total = await Transaction.countDocuments({ oxyUserId: req.user!.id });
    res.json({ transactions, total });
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error fetching transactions');
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
    log.credits.error({ err: error }, 'Error creating portal session');
    res.status(500).json({ error: error.message });
  }
});

// Entitlements: returns allowed models + feature flags for the current user
router.get('/entitlements', authenticateToken, async (req: Request, res: Response) => {
  try {
    const entitlements = await getUserEntitlements(req.user!.id);
    res.json(entitlements);
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error fetching entitlements');
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
    log.credits.error({ err }, 'Webhook verification failed');
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
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
    }
    res.json({ received: true });
  } catch (error: any) {
    log.credits.error({ err: error }, 'Error handling webhook');
    res.status(500).json({ error: error.message });
  }
});

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;

  // Handle credit purchases
  if (metadata?.type === 'credit_purchase') {
    if (!metadata.userId) return;
    const credits = parseInt(metadata.credits || '0');
    if (credits <= 0) return;

    const userCredits = await getOrCreateUserCredits(metadata.userId);
    await userCredits.addCredits(credits, 'paid');
    log.credits.info({ credits, userId: metadata.userId }, 'Added credits to user');

    try {
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
    } catch (err: any) {
      if (err.code === 11000) {
        log.credits.warn({ paymentIntent: session.payment_intent }, 'Duplicate checkout event, skipping');
        return;
      }
      throw err;
    }
    return;
  }

  // Handle subscription checkouts as fallback (in case customer.subscription.created is delayed)
  if (session.mode === 'subscription' && session.subscription) {
    log.credits.info({ subscriptionId: session.subscription }, 'checkout.session.completed, fetching and syncing');
    const stripeSubscription = await getStripe().subscriptions.retrieve(session.subscription as string);
    await handleSubscriptionUpdate(stripeSubscription);
  }
}

async function handleSubscriptionUpdate(stripeSubscription: Stripe.Subscription) {
  const customerId = stripeSubscription.customer as string;
  const metadata = stripeSubscription.metadata;

  // Find UserCredits by Stripe customer ID, fall back to userId from metadata
  let userCredits = await UserCredits.findOne({ stripeCustomerId: customerId });
  if (!userCredits) {
    if (metadata?.userId) {
      log.credits.warn({ customerId, userId: metadata.userId }, 'No UserCredits for stripeCustomerId, falling back to userId');
      userCredits = await getOrCreateUserCredits(metadata.userId);
      if (!userCredits.stripeCustomerId) {
        userCredits.stripeCustomerId = customerId;
        await userCredits.save();
      }
    } else {
      throw new Error(`No UserCredits found for stripeCustomerId ${customerId} and no userId in metadata`);
    }
  }

  // Match plan by metadata (set via subscription_data.metadata in checkout)
  const resolvedPlanId = LEGACY_PLAN_MAP[metadata?.planId || ''] || metadata?.planId;
  const plan = await Plan.findOne({ planId: resolvedPlanId }).lean();
  if (!plan) {
    throw new Error(`Plan not found for subscription ${stripeSubscription.id}, planId: ${resolvedPlanId}`);
  }

  const isAnnual = metadata?.billingPeriod === 'annual';
  const price = isAnnual ? plan.annualPrice : plan.monthlyPrice;
  const sub = stripeSubscription as any;

  // Stripe API 2025+ moved current_period_start/end to subscription items
  const item = stripeSubscription.items.data[0] as any;
  const periodStart = item?.current_period_start ?? sub.current_period_start;
  const periodEnd = item?.current_period_end ?? sub.current_period_end;

  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: stripeSubscription.id },
    {
      oxyUserId: userCredits._id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: stripeSubscription.items.data[0].price.id,
      status: stripeSubscription.status,
      currentPeriodStart: periodStart ? new Date(periodStart * 1000) : new Date(),
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      planId: plan.planId,
      billingPeriod: isAnnual ? 'annual' : 'monthly',
      plan: { planId: plan.planId, name: plan.name, product: plan.product, creditsPerMonth: plan.creditsPerMonth, price, currency: plan.currency, billingPeriod: isAnnual ? 'annual' : 'monthly' },
    },
    { upsert: true, new: true }
  );

  // Add subscription credits with dedup protection (no time window — dedup key prevents duplicates)
  if (stripeSubscription.status === 'active') {
    const dedupKey = `${stripeSubscription.id}_${periodStart || Date.now()}`;
    try {
      // Create transaction first as dedup lock, then add credits
      await Transaction.create({
        oxyUserId: userCredits._id,
        stripeCustomerId: customerId,
        type: 'subscription_payment',
        amount: price,
        currency: plan.currency,
        credits: plan.creditsPerMonth,
        status: 'completed',
        description: `${plan.name} subscription credits (${isAnnual ? 'annual' : 'monthly'})`,
        metadata: { dedup: dedupKey },
      });
      await userCredits.addCredits(plan.creditsPerMonth, 'paid');
      log.credits.info({ credits: plan.creditsPerMonth, subscriptionId: stripeSubscription.id, periodStart }, 'Added subscription credits');
    } catch (err: any) {
      if (err.code === 11000) {
        log.credits.warn({ dedupKey }, 'Duplicate subscription credit event, skipping');
        return;
      }
      throw err;
    }
  }

  invalidateEntitlementsCache(userCredits._id);
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription) {
  const sub = await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: stripeSubscription.id },
    { status: 'canceled' }
  );
  if (sub?.oxyUserId) invalidateEntitlementsCache(sub.oxyUserId);
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails?.subscription) return null;
  return typeof subDetails.subscription === 'string'
    ? subDetails.subscription
    : subDetails.subscription.id;
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.info({ subscriptionId }, 'Invoice payment succeeded');
  const stripeSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
  await handleSubscriptionUpdate(stripeSubscription);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  log.credits.error({ subscriptionId, invoiceId: invoice.id }, 'Invoice payment failed');
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscriptionId },
    { status: 'past_due' }
  );
}

export default router;
