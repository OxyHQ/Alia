import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticateToken, optionalAuth, oxyClient } from '../middleware/auth.js';
import { UserCredits, type IUserCredits } from '../models/user-credits.js';
import { Subscription } from '../models/subscription.js';
import { Transaction } from '../models/transaction.js';
import { getPlans, getCreditPackages, getFeatures, getPlanFeatures, getAllAliaModels, type PlanFeatureData } from '../lib/gateway-client.js';
import { ensureStripePriceId } from '../lib/stripe-prices.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { getUserEntitlements, invalidateEntitlementsCache } from '../lib/plan-access.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';
import { sanitizeMessage, isDuplicateKeyError } from '../lib/errors/index.js';

const router = Router();
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not defined');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-01-28.clover',
    });
  }
  return stripeInstance;
}

function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

// Helper to get or create Stripe customer
async function getOrCreateStripeCustomer(userId: string, userCredits: IUserCredits): Promise<string> {
  const existingCustomerId = userCredits.stripeCustomerId;

  if (existingCustomerId) {
    try {
      await getStripe().customers.retrieve(existingCustomerId);
      return existingCustomerId;
    } catch (err: unknown) {
      log.credits.warn(
        { err, customerId: existingCustomerId, userId },
        'Existing Stripe customer not retrievable — creating a new one',
      );
    }
  }

  // Fetch email from Oxy
  let email: string | undefined;
  try {
    const oxyUser = await oxyClient.getUserById(userId);
    email = oxyUser?.email;
  } catch (e: unknown) {
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

router.get('/packages', async (_req: Request, res: Response) => {
  try {
    const packages = await getCreditPackages(true);
    res.json({
      packages: packages.map(p => ({
        id: p.packageId,
        name: p.name,
        credits: p.credits,
        price: p.price,
        currency: p.currency,
      })),
    });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching packages');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit packages') });
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

    const allPackages = await getCreditPackages(true);
    const pkg = allPackages.find(p => p.packageId === packageId);
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
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating checkout session');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create checkout session') });
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
    const packages = await getCreditPackages(true);
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
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating custom credits checkout');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create custom credits checkout') });
  }
});

// Expose the per-credit rate so the frontend can show live pricing
router.get('/credit-price', async (_req: Request, res: Response) => {
  try {
    let pricePerCredit = CREDIT_PRICE_PER_1K_CENTS / 1000;
    const creditPricePackages = await getCreditPackages(true);
    if (creditPricePackages.length > 0) {
      pricePerCredit = Math.min(...creditPricePackages.map(p => p.price / p.credits));
    }
    res.json({ pricePerCreditCents: pricePerCredit, minCredits: MIN_CUSTOM_CREDITS, maxCredits: MAX_CUSTOM_CREDITS });
  } catch (error: unknown) {
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch credit price') });
  }
});

router.get('/plans', async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const planFilter: Record<string, unknown> = { isActive: true };
    if (product) planFilter.product = product;

    const [dbPlans, rawFeatures, rawPlanFeatures] = await Promise.all([
      getPlans(planFilter),
      getFeatures(),
      getPlanFeatures(),
    ]);
    // Filter features/plan-features client-side (API may return all)
    const allFeatures = rawFeatures.filter(f => f.isActive !== false && f.isVisibleOnPricing !== false);
    const allPlanFeatures = rawPlanFeatures.filter(pf => pf.enabled !== false);

    // Build lookup: planId -> featureId -> PlanFeature mapping
    const pfMap: Record<string, Record<string, PlanFeatureData>> = {};
    for (const pf of allPlanFeatures) {
      if (!pfMap[pf.planId]) pfMap[pf.planId] = {};
      pfMap[pf.planId][pf.featureId] = pf;
    }

    // Load all Alia models from providers API
    let modelMap: Record<string, { displayName: string; description?: string }> = {};
    try {
      const aliaModels = await getAllAliaModels();
      for (const m of aliaModels) {
        modelMap[m.id] = { displayName: m.name, description: m.description };
      }
    } catch { /* ignore */ }

    const plans = dbPlans.map(p => {
      const planId = p.planId;
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
      const modelIds: string[] = p.modelIds || [];
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
        sortOrder: p.sortOrder,
      };
    });
    res.json({ plans });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching plans');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch plans') });
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

    const matchingPlans = await getPlans({ planId, isActive: true, isFree: false });
    const plan = matchingPlans[0];
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

    let stripePriceId: string;
    try {
      stripePriceId = await ensureStripePriceId(getStripe, plan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: plan.planId, billingPeriod }, 'Failed to ensure Stripe price for checkout');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    const lineItem = { price: stripePriceId, quantity: 1 };

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
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error creating subscription checkout');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create subscription checkout') });
  }
});

router.get('/subscription', optionalAuth, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.json({ subscription: null });
    }
    const product = req.query.product as string | undefined;
    const query: Record<string, unknown> = {
      oxyUserId: req.user.id,
      status: { $in: ['active', 'trialing'] },
    };
    if (product) {
      query['plan.product'] = product;
    }
    const subscription = await Subscription.findOne(query).lean();
    res.json({ subscription });
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch subscription') });
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
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error canceling subscription');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to cancel subscription') });
  }
});

const changePlanSchema = z.object({
  planId: z.string(),
  billingPeriod: z.enum(['monthly', 'annual']).default('monthly'),
});

router.post('/subscription/change-plan', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { planId, billingPeriod } = changePlanSchema.parse(req.body);
    const userId = req.user!.id;

    // Find existing active subscription
    const subscription = await Subscription.findOne({
      oxyUserId: userId,
      status: { $in: ['active', 'trialing'] },
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Find target plan
    const targetPlans = await getPlans({ planId, isActive: true, isFree: false });
    const targetPlan = targetPlans[0];
    if (!targetPlan) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    // Guard: same plan + same billing period
    if (subscription.planId === planId && subscription.billingPeriod === billingPeriod) {
      return res.status(400).json({ error: 'You are already on this plan' });
    }

    // Look up current plan for sortOrder comparison
    const currentPlans = await getPlans({ planId: subscription.planId });
    const currentPlan = currentPlans[0];
    if (!currentPlan) {
      return res.status(500).json({ error: 'Current plan not found' });
    }

    const isUpgrade = targetPlan.sortOrder > currentPlan.sortOrder;
    const isAnnual = billingPeriod === 'annual';

    let targetPriceId: string;
    try {
      targetPriceId = await ensureStripePriceId(getStripe, targetPlan.planId, billingPeriod);
    } catch (err: unknown) {
      log.credits.error({ err, planId: targetPlan.planId, billingPeriod }, 'Failed to ensure Stripe price');
      return res.status(500).json({ error: 'Failed to configure plan pricing' });
    }

    // Retrieve Stripe subscription to get item ID
    const stripeSubscription = await getStripe().subscriptions.retrieve(subscription.stripeSubscriptionId);
    const itemId = stripeSubscription.items.data[0]?.id;
    if (!itemId) {
      return res.status(500).json({ error: 'Could not find subscription item' });
    }

    // If pending cancellation, undo it first
    if (stripeSubscription.cancel_at_period_end) {
      await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    // Update the Stripe subscription
    await getStripe().subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: itemId, price: targetPriceId }],
      proration_behavior: isUpgrade ? 'always_invoice' : 'none',
      metadata: {
        ...stripeSubscription.metadata,
        planId: targetPlan.planId,
        billingPeriod,
        product: targetPlan.product,
      },
    });

    // Update local subscription document
    const price = isAnnual ? targetPlan.annualPrice : targetPlan.monthlyPrice;
    subscription.planId = targetPlan.planId;
    subscription.billingPeriod = billingPeriod;
    subscription.cancelAtPeriodEnd = false;
    subscription.stripePriceId = targetPriceId;
    subscription.plan = {
      planId: targetPlan.planId,
      name: targetPlan.name,
      product: targetPlan.product,
      creditsPerMonth: targetPlan.creditsPerMonth,
      price,
      currency: targetPlan.currency,
      billingPeriod,
    };
    await subscription.save();

    invalidateEntitlementsCache(userId);

    const direction = isUpgrade ? 'upgrade' : 'downgrade';
    log.credits.info({ userId, from: currentPlan.planId, to: targetPlan.planId, direction, billingPeriod }, 'Plan changed');
    res.json({ message: 'Plan changed successfully', subscription, direction });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.credits.error({ err: error }, 'Error changing plan');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to change plan') });
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
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching transactions');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch transactions') });
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
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error creating portal session');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to create billing portal session') });
  }
});

// Entitlements: returns allowed models + feature flags for the current user
router.get('/entitlements', authenticateToken, async (req: Request, res: Response) => {
  try {
    const entitlements = await getUserEntitlements(req.user!.id);
    res.json(entitlements);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching entitlements');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch entitlements') });
  }
});

// Voice usage: returns current voice minutes used vs limit for the billing period
router.get('/voice-usage', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { getUserEntitlements: getEntitlements } = await import('../lib/plan-access.js');
    const { getVoiceUsageSummary } = await import('../lib/voice-usage.js');

    const entitlements = await getEntitlements(req.user!.id);
    const voiceMinutesLimit = entitlements.features['voice-minutes'];

    if (typeof voiceMinutesLimit !== 'number' || voiceMinutesLimit <= 0) {
      return res.json({ usedMinutes: 0, limitMinutes: 0, remainingMinutes: 0 });
    }

    const usage = await getVoiceUsageSummary(req.user!.id, voiceMinutesLimit);
    res.json(usage);
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error fetching voice usage');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to fetch voice usage') });
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
  } catch (err: unknown) {
    log.credits.error({ err }, 'Webhook verification failed');
    return res.status(400).send(`Webhook Error: ${getSafeErrorMessage(err, 'Invalid webhook payload')}`);
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
  } catch (error: unknown) {
    log.credits.error({ err: error }, 'Error handling webhook');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Failed to process webhook') });
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
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
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
  const planId = metadata?.planId;
  const resolvedPlans = await getPlans({ planId });
  const plan = resolvedPlans[0];
  if (!plan) {
    throw new Error(`Plan not found for subscription ${stripeSubscription.id}, planId: ${planId}`);
  }

  const isAnnual = metadata?.billingPeriod === 'annual';
  const price = isAnnual ? plan.annualPrice : plan.monthlyPrice;

  // Stripe API 2025+: period fields are on subscription items
  const item = stripeSubscription.items.data[0];
  const periodStart = item?.current_period_start;
  const periodEnd = item?.current_period_end;

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
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      planId: plan.planId,
      billingPeriod: isAnnual ? 'annual' : 'monthly',
      plan: { planId: plan.planId, name: plan.name, product: plan.product, creditsPerMonth: plan.creditsPerMonth, price, currency: plan.currency, billingPeriod: isAnnual ? 'annual' : 'monthly' },
    },
    { upsert: true, returnDocument: 'after' }
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
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
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
