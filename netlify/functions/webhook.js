// netlify/functions/webhook.js
// Served at /api/webhook via the redirect in netlify.toml.
// Register THIS url in the Stripe dashboard:
//   https://samuraivengeance.com/api/webhook

const Stripe = require('stripe');
const admin  = require('firebase-admin');

let _initError = null;

// Accept a private key in whatever shape it survived the copy-paste in.
function normalizePrivateKey(raw) {
  let k = (raw || '').trim();
  if (!k) return null;
  if ((k.startsWith('"') && k.endsWith('"')) ||
      (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  k = k.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  k = k.replace(/\r\n/g, '\n');
  if (!k.includes('BEGIN') || !k.includes('END')) return null;
  return k;
}

function getDb() {
  if (!admin.apps.length) {
    const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
      .filter(k => !process.env[k]);
    if (missing.length) {
      _initError = 'Missing env vars: ' + missing.join(', ');
      return null;
    }

    const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
    if (!privateKey) {
      _initError = 'FIREBASE_PRIVATE_KEY is set but is not a PEM key — it must '
                 + 'contain both BEGIN and END PRIVATE KEY lines.';
      return null;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
    } catch (err) {
      _initError = 'Firebase credential rejected: ' + err.message
                 + ' — check FIREBASE_PRIVATE_KEY and FIREBASE_CLIENT_EMAIL.';
      return null;
    }
  }
  return admin.firestore();
}

async function grantPremium(db, userId) {
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId),
    { isPrem: true, premGrantedAt: new Date().toISOString() },
    { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { isPrem: true }, { merge: true });
  await batch.commit();
  console.log('✅ Premium granted:', userId);
}

async function grantSeason(db, userId, subscriptionId) {
  const expiry = Date.now() + 31 * 24 * 60 * 60 * 1000;
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId), {
    hasSeason: true,
    seasonExpiry: new Date(expiry).toISOString(),
    seasonSubId: subscriptionId || '',
    seasonGrantedAt: new Date().toISOString(),
  }, { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { hasSeason: true }, { merge: true });
  await batch.commit();
  console.log('✅ Season pass granted:', userId);
}

async function grantStarter(db, userId) {
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId), {
    isPrem: true,
    starterClaimed: true,
    starterCoins: admin.firestore.FieldValue.increment(500),
    starterCoinsClaimed: false,
    starterSkin: 'bronze',
    premGrantedAt: new Date().toISOString(),
  }, { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { isPrem: true }, { merge: true });
  await batch.commit();
  console.log('✅ Starter bundle granted:', userId);
}

async function revokeSeason(db, userId) {
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId),
    { hasSeason: false, seasonExpiry: null }, { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { hasSeason: false }, { merge: true });
  await batch.commit();
  console.log('⚠ Season pass revoked:', userId);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Webhook error: ' + err.message }) };
  }

  const db = getDb();
  if (!db) {
    console.error('Firebase Admin not initialized —', _initError);
    return { statusCode: 500, body: JSON.stringify({ error: _initError }) };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const { userId, product } = session.metadata || {};
      if (!userId) {
        return { statusCode: 200, body: JSON.stringify({ received: true }) };
      }
      if (product === 'premium') await grantPremium(db, userId);
      if (product === 'starter') await grantStarter(db, userId);
      if (product === 'season')  await grantSeason(db, userId, session.subscription);
    }

    if (stripeEvent.type === 'invoice.paid') {
      const invoice = stripeEvent.data.object;
      if (invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata && sub.metadata.userId;
        if (userId) await grantSeason(db, userId, invoice.subscription);
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      const userId = sub.metadata && sub.metadata.userId;
      if (userId) await revokeSeason(db, userId);
    }
  } catch (err) {
    // Previously this swallowed the error and returned 200, telling Stripe the
    // event was handled when nothing had been written — a silent failure with
    // no retry and no visible symptom. A 500 makes Stripe retry and puts the
    // reason straight in the Event deliveries response body.
    console.error('Firestore update failed:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Firestore write failed: ' + err.message,
        code: err.code || null,
        hint: 'Check that FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY come '
            + 'from the SAME service account JSON, and that FIREBASE_PROJECT_ID '
            + 'matches that file.',
      }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
