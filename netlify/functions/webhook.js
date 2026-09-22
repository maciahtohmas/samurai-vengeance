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

// Where the service account came from, for error messages.
let _credSource = 'none';

// Two ways to supply credentials.
//
// PREFERRED: FIREBASE_SERVICE_ACCOUNT_JSON — the whole downloaded JSON file,
// pasted as one value. Select-all, copy, paste. It is impossible to mix
// fields from different service accounts this way, which is exactly the
// failure that produces "16 UNAUTHENTICATED": a private key that parses fine
// but does not belong to the client_email sitting next to it.
//
// FALLBACK: the three separate variables, for anyone already set up that way.
function loadCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();

  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message
                    + '. Paste the entire file, starting with { and ending with }.' };
    }
    const privateKey = normalizePrivateKey(parsed.private_key);
    const gaps = [];
    if (!parsed.project_id)   gaps.push('project_id');
    if (!parsed.client_email) gaps.push('client_email');
    if (!privateKey)          gaps.push('private_key');
    if (gaps.length) {
      return { error: 'FIREBASE_SERVICE_ACCOUNT_JSON is missing: ' + gaps.join(', ') };
    }
    _credSource = 'FIREBASE_SERVICE_ACCOUNT_JSON (' + parsed.client_email + ')';
    return { cred: {
      projectId:   parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey,
    } };
  }

  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return { error: 'No credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON to the whole '
                  + 'service account file, or supply: ' + missing.join(', ') };
  }

  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  if (!privateKey) {
    return { error: 'FIREBASE_PRIVATE_KEY is set but is not a PEM key — it must '
                  + 'contain both BEGIN and END PRIVATE KEY lines.' };
  }
  _credSource = 'separate FIREBASE_* vars (' + process.env.FIREBASE_CLIENT_EMAIL + ')';
  return { cred: {
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  } };
}

function getDb() {
  if (!admin.apps.length) {
    const { cred, error } = loadCredential();
    if (error) { _initError = error; return null; }

    try {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    } catch (err) {
      _initError = 'Firebase credential rejected: ' + err.message
                 + ' (source: ' + _credSource + ')';
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
    // Previously this swallowed the error and returned 200, which told Stripe
    // the event was handled when nothing had been written — a silent failure
    // with no retry and no visible symptom. A 500 makes Stripe retry (so a
    // transient Firestore blip self-heals) and puts the reason straight in
    // the Event deliveries response body, where it can actually be read.
    console.error('Firestore update failed:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Firestore write failed: ' + err.message,
        code: err.code || null,
        credentialSource: _credSource,
        hint: err.code === 16
          ? 'UNAUTHENTICATED means the private key does not belong to that '
          + 'client_email, or the service account was deleted. Easiest fix: set '
          + 'FIREBASE_SERVICE_ACCOUNT_JSON to the ENTIRE service account file '
          + 'contents in one paste, which makes a mismatch impossible.'
          : 'Check the service account credentials.',
      }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
