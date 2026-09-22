// netlify/functions/create-checkout.js
// Served at /api/create-checkout via the redirect in netlify.toml.
//
// Same-origin with the game, so no CORS headers are needed.
//
// Handles Premium ($2.99), Season Pass ($1.99/mo), Starter Bundle ($0.99).

const Stripe = require('stripe');

const PRODUCTS = {
  premium: {
    name: 'Samurai Vengeance Premium',
    description: 'Remove all ads forever · Bonus coins · Cloud save',
    amount: 299, mode: 'payment',
  },
  season: {
    name: 'Samurai Vengeance Season Pass',
    description: 'Double coins · Exclusive skin · Gold leaderboard name · All chapters',
    amount: 199, mode: 'subscription',
  },
  starter: {
    name: 'Samurai Vengeance Starter Bundle',
    description: 'Premium + 500 Coins + Bronze skin — one-time offer',
    amount: 99, mode: 'payment',
  },
};

const BASE = 'https://samuraivengeance.com';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set');
    return json(500, { error: 'Payments are not configured' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Invalid JSON body' });
    }

    const { userId, email, product = 'premium' } = payload;
    if (!userId) return json(400, { error: 'userId required' });

    const prod = PRODUCTS[product];
    if (!prod) return json(400, { error: 'Unknown product: ' + product });

    const common = {
      customer_email: email || undefined,
      metadata: { userId, product },
      success_url: BASE + '?payment_success=' + product + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  BASE + '?payment_cancel=1',
    };

    let session;
    if (prod.mode === 'subscription') {
      session = await stripe.checkout.sessions.create({
        ...common,
        mode: 'subscription',

        // Copy metadata onto the SUBSCRIPTION, not just the session. Renewal
        // and cancellation events carry the subscription, not the session —
        // without this the webhook can never resolve a userId.
        subscription_data: { metadata: { userId, product } },

        line_items: [{
          price_data: {
            currency: 'usd',
            recurring: { interval: 'month' },
            unit_amount: prod.amount,
            product_data: { name: prod.name, description: prod.description },
          },
          quantity: 1,
        }],
      });
    } else {
      session = await stripe.checkout.sessions.create({
        ...common,
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: prod.amount,
            product_data: { name: prod.name, description: prod.description },
          },
          quantity: 1,
        }],
      });
    }

    return json(200, { url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    return json(500, { error: 'Failed to create checkout session' });
  }
};
