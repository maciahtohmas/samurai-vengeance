// netlify/functions/webhook.js
// Served at /api/webhook via the redirect in netlify.toml.
// Register THIS url in the Stripe dashboard:
//   https://samuraivengeance.com/api/webhook
//
// Handles: premium, starter bundle, season pass, subscription renewals and
// cancellations. Grants are written with the Firebase Admin SDK, which
// bypasses Firestore security rules — that is precisely why the rules can
// lock every paid field against the browser without blocking this.

const Stripe = require('stripe');
const admin  = require('firebase-admin');

// ── Firebase Admin init ──────────────────────────────────────────
// Deliberately lazy. Doing this at module scope means a single missing env
// var throws during cold start, and Netlify reports that as an opaque 500
// with no clue which variable is wrong.
let _initError = null;

// Accept a private key in whatever shape it survived the copy-paste in.
// Env var UIs and phone keyboards mangle this value in predictable ways:
// the JSON's surrounding quotes get included, the \n escapes arrive literal
// or double-escaped, or real newlines come through instead. All are fine;
// what matters is ending up with genuine newlines and no stray quotes.
// Returns null if the result is not a plausible PEM key.
function normalizePrivateKey(raw) {
  let k = (raw || '').trim();
  if (!k) return null;

  // Strip one layer of wrapping quotes, if the whole JSON value was pasted.
  if ((k.startsWith('"') && k.endsWith('"')) ||
      (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }

  // Double-escaped first (\\n), then single (\n). Order matters.
  k = k.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');

  // Some inputs arrive with literal CRLF; PEM parsers want bare newlines.
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
                 + 'contain both BEGIN and END PRIVATE KEY lines. Check that the '
                 + 'surrounding double quotes from the JSON were not included, '
                 + 'and that the whole value was pasted (it is ~1700 chars).';
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
      // Without this, a malformed key throws raw out of the handler and
      // Netlify reports only "Invalid PEM formatted message" with no hint
      // about which variable or why.
      _initError = 'Firebase credential rejected: ' + err.message
                 + ' — check FIREBASE_PRIVATE_KEY and FIREBASE_CLIENT_EMAIL.';
      return null;
    }
  }
  return admin.firestore();
}

// ── Grants ───────────────────────────────────────────────────────
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
  console.log('✅ Season pass granted:', userId, '→', new Date(expiry).toISOString());
}

async function grantStarter(db, userId) {
  const batch = db.batch();
  // Premium + 500 coins + bronze skin. `starterCoinsClaimed: false` lets the
  // client credit the coins exactly once and then flip the flag; without it
  // the client re-granted 500 coins on every single sign-in.
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

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];

  // Stripe verifies the signature against the EXACT bytes it sent, so the
  // body must not be parsed or re-serialized first. Netlify hands it over as
  // a string, base64-encoded when it considers the payload binary.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Webhook error: ' + err.message }) };
  }

  // Signature is good, so this is a real Stripe event. Only now do we need
  // Firestore. A 500 here makes Stripe retry, which is what we want: once
  // the missing variable is set, the queued events replay and land.
  const db = getDb();
  if (!db) {
    console.error('Firebase Admin not initialized —', _initError);
    return { statusCode: 500, body: JSON.stringify({ error: _initError }) };
  }

  try {
    // Payment completed — premium, starter, or a season pass's first charge.
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const { userId, product } = session.metadata || {};
      if (!userId) {
        console.log('No userId in session metadata');
        return { statusCode: 200, body: JSON.stringify({ received: true }) };
      }
      if (product === 'premium') await grantPremium(db, userId);
      if (product === 'starter') await grantStarter(db, userId);
      if (product === 'season')  await grantSeason(db, userId, session.subscription);
    }

    // Monthly renewal.
    if (stripeEvent.type === 'invoice.paid') {
      const invoice = stripeEvent.data.object;
      // One-off invoices carry no subscription — guard before retrieving.
      if (invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata && sub.metadata.userId;
        if (userId) await grantSeason(db, userId, invoice.subscription);
        else console.log('No userId on subscription', invoice.subscription);
      }
    }

    // Cancellation.
    if (stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      const userId = sub.metadata && sub.metadata.userId;
      if (userId) await revokeSeason(db, userId);
      else console.log('No userId on cancelled subscription', sub.id);
    }
  } catch (err) {
    // Return 200 so Stripe stops retrying; the log is the record for a
    // manual fix. Check these in Netlify → Functions → webhook.
    console.error('Firestore update failed:', err.message);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
