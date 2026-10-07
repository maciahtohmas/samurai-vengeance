// netlify/functions/count.js
// Served at /api/count via the existing /api/* redirect in netlify.toml.
//
// A consent-free aggregate counter. It answers the one question Netlify
// Analytics structurally cannot: of the people who arrive, how many actually
// play, and where do they stop?
//
// WHAT IT STORES: integers. "47 people reached the menu today." That is the
// whole data model. No cookies, nothing written to the visitor's device, no
// identifier, no IP, no session, no per-person row — not even a hashed one.
// Nothing here can be tied back to a person, which is why it needs no consent
// banner and therefore fires for EVERY visitor, not just the ~1% who accept
// one. GA4 sees a fraction of reality; this sees all of it.
//
// The credential loading below is copied from webhook.js rather than shared.
// That is deliberate: refactoring a working payment path to add an analytics
// feature is a bad trade. If you fix a credential bug, fix it in both.

const admin = require('firebase-admin');

// ── Firebase Admin init (mirrors webhook.js) ─────────────────────
let _initError = null;
let _credSource = 'none';

function normalizePrivateKey(raw) {
  let k = (raw || '').trim();
  if (!k) return null;
  if ((k.startsWith('"') && k.endsWith('"')) ||
      (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  k = k.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  if (!k.includes('BEGIN') || !k.includes('END')) return null;
  return k;
}

function loadCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { return { error: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message }; }
    const privateKey = normalizePrivateKey(parsed.private_key);
    if (!parsed.project_id || !parsed.client_email || !privateKey) {
      return { error: 'FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email or private_key' };
    }
    _credSource = 'FIREBASE_SERVICE_ACCOUNT_JSON';
    return { cred: { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey } };
  }
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) return { error: 'No credentials. Missing: ' + missing.join(', ') };
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  if (!privateKey) return { error: 'FIREBASE_PRIVATE_KEY is not a PEM key' };
  _credSource = 'separate FIREBASE_* vars';
  return {
    cred: {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    },
  };
}

function getDb() {
  if (!admin.apps.length) {
    const { cred, error } = loadCredential();
    if (error) { _initError = error; return null; }
    try { admin.initializeApp({ credential: admin.credential.cert(cred) }); }
    catch (err) { _initError = 'Firebase credential rejected: ' + err.message; return null; }
  }
  return admin.firestore();
}

// ── Event vocabulary ─────────────────────────────────────────────
// An allowlist, not a filter. The endpoint is public, so without this anyone
// could invent field names and grow the document without limit.
const SIMPLE = new Set(['arrived', 'menu']);
const STAGED = new Set(['s_start', 's_clear', 'death', 'quit']);
const DIFFS  = new Set(['easy', 'normal', 'hard']);

// Stage numbers are exact up to 100 and pooled above it. The interesting part
// of the curve is the first couple of dozen stages; nobody needs to know that
// one person died on stage 734 in particular.
function stageKey(n) {
  const v = Math.floor(Number(n));
  if (!isFinite(v) || v < 1 || v > 1000) return null;
  return v <= 100 ? String(v) : '100plus';
}

// Pacific day. The user is in America/Los_Angeles, so bucketing by UTC would
// split his evening — the busiest hours — across two rows.
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function fieldFor(body) {
  const e = String(body.e || '');
  if (SIMPLE.has(e)) return e;
  if (e === 'start') {
    const d = String(body.d || 'normal');
    return DIFFS.has(d) ? 'start_' + d : null;
  }
  if (STAGED.has(e)) {
    const k = stageKey(body.v);
    return k && (e + '_' + k);
  }
  return null;
}

// ── Read view ────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderReport(days) {
  const row = (label, n, base) => {
    const pct = base ? Math.round((n / base) * 100) : null;
    const w = base ? Math.max(1.5, (n / base) * 100) : 0;
    return `<tr><th>${esc(label)}</th><td class="n">${n}</td>
      <td class="pct">${pct === null ? '' : pct + '%'}</td>
      <td class="bar"><span style="width:${w}%"></span></td></tr>`;
  };

  const blocks = days.map(d => {
    const g = k => d.data[k] || 0;
    const arrived = g('arrived');
    const started = g('start_easy') + g('start_normal') + g('start_hard');

    const funnel = [
      row('Arrived', arrived, arrived),
      row('Reached the menu', g('menu'), arrived),
      row('Started a run', started, arrived),
      row('Began stage 1', g('s_start_1'), arrived),
      row('Cleared stage 1', g('s_clear_1'), arrived),
    ].join('');

    const diffs = DIFFS_ORDER.map(k => {
      const n = g('start_' + k);
      return n ? `<li><b>${n}</b> ${esc(DIFF_LABEL[k])}</li>` : '';
    }).join('');

    // Where runs end. A stage is "lost" when someone began it and neither
    // cleared it nor is still on it — deaths and quits are the signal.
    const walls = [];
    for (let i = 1; i <= 100; i++) {
      const s = g('s_start_' + i);
      if (!s) continue;
      const c = g('s_clear_' + i);
      const lost = g('death_' + i) + g('quit_' + i);
      walls.push({ i, s, c, lost, rate: s ? lost / s : 0 });
    }
    walls.sort((a, b) => (b.lost - a.lost) || (b.rate - a.rate));
    const wallRows = walls.slice(0, 8).map(w =>
      `<tr><th>Stage ${w.i}</th><td class="n">${w.s}</td><td class="n">${w.c}</td>
       <td class="n">${w.lost}</td><td class="pct">${Math.round(w.rate * 100)}%</td></tr>`).join('');

    return `<section>
      <h2>${esc(d.id)}</h2>
      ${arrived ? `<table class="funnel">${funnel}</table>` : '<p class="empty">No traffic recorded.</p>'}
      ${diffs ? `<ul class="diffs">${diffs}</ul>` : ''}
      ${wallRows ? `<h3>Where runs ended</h3>
        <table class="walls"><thead><tr><th></th><th>began</th><th>cleared</th>
        <th>lost</th><th>loss</th></tr></thead><tbody>${wallRows}</tbody></table>` : ''}
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Player funnel</title>
<style>
:root{--bg:#0d0409;--card:#160a12;--line:rgba(220,180,80,.16);--ink:#f0e4c8;
  --dim:rgba(240,228,200,.52);--gold:#e8c56a;--bar:rgba(232,197,106,.3);}
*{box-sizing:border-box;}
body{margin:0;padding:20px 16px 56px;background:var(--bg);color:var(--ink);
  font:15px/1.6 Georgia,'Times New Roman',serif;-webkit-text-size-adjust:100%;}
h1{font-size:19px;letter-spacing:.18em;text-transform:uppercase;font-weight:400;
  color:var(--gold);margin:0 0 4px;}
.sub{color:var(--dim);font-size:12.5px;margin:0 0 26px;}
section{background:var(--card);border:1px solid var(--line);border-radius:3px;
  padding:16px 14px;margin-bottom:14px;}
h2{font-size:12px;letter-spacing:.2em;color:var(--dim);font-weight:400;margin:0 0 12px;}
h3{font-size:11px;letter-spacing:.2em;color:var(--dim);font-weight:400;
  text-transform:uppercase;margin:20px 0 8px;}
table{width:100%;border-collapse:collapse;}
th{text-align:left;font-weight:400;}
.funnel th{width:42%;font-size:14px;}
.funnel .n{width:3.2em;text-align:right;font-size:17px;color:var(--gold);}
.funnel .pct{width:3.4em;text-align:right;font-size:11.5px;color:var(--dim);padding-left:7px;}
.funnel .bar{padding-left:10px;}
.funnel .bar span{display:block;height:6px;background:var(--bar);border-radius:3px;}
.funnel tr td,.funnel tr th{padding:5px 0;}
.walls{font-size:13px;}
.walls thead th{font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dim);text-align:right;padding-bottom:5px;}
.walls thead th:first-child{text-align:left;}
.walls td{text-align:right;padding:4px 0 4px 10px;}
.walls tbody th{font-size:13px;}
.walls .pct{color:var(--gold);}
.diffs{list-style:none;padding:0;margin:14px 0 0;display:flex;gap:16px;
  flex-wrap:wrap;font-size:12.5px;color:var(--dim);}
.diffs b{color:var(--ink);font-size:14px;}
.empty{color:var(--dim);font-size:13px;margin:0;}
footer{color:var(--dim);font-size:11.5px;line-height:1.7;margin-top:22px;}
</style></head><body>
<h1>Player funnel</h1>
<p class="sub">Samurai Vengeance &middot; last ${days.length} days &middot; Pacific</p>
${blocks}
<footer>Counts only &mdash; no cookies, no identifiers, nothing stored on any
visitor's device. Fires for every visitor, not just those who accept the
consent banner.</footer>
</body></html>`;
}

const DIFFS_ORDER = ['easy', 'normal', 'hard'];
const DIFF_LABEL = { easy: 'on Peace', normal: 'on Warrior', hard: 'on Demon' };

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  // ---- READ ----
  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters || {}).key || '';
    const want = process.env.COUNTER_KEY || '';
    // No key configured, or the wrong one: behave as if nothing is here.
    if (!want || key !== want) {
      return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
    }
    const db = getDb();
    if (!db) return { statusCode: 500, body: 'Counter unavailable: ' + _initError };

    const ids = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000);
      ids.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
    }
    const snaps = await db.getAll(...ids.map(id => db.collection('counters').doc(id)));
    const days = snaps.map((s, i) => ({ id: ids[i], data: s.exists ? s.data() : {} }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: renderReport(days),
    };
  }

  // ---- WRITE ----
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Weak origin check. Trivial to forge, so it is not a security control —
  // it just keeps stray bots and copies of the file hosted elsewhere out of
  // the numbers.
  const origin = event.headers.origin || event.headers.referer || '';
  if (origin && !/samuraivengeance\.com|localhost|127\.0\.0\.1|netlify\.app/.test(origin)) {
    return { statusCode: 204, body: '' };
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    body = JSON.parse(raw);
  } catch (_) {
    return { statusCode: 400, body: 'Bad body' };
  }

  // Accept a single event or a small batch, so a page unload can flush
  // everything it has in one beacon.
  const items = Array.isArray(body) ? body.slice(0, 12) : [body];
  const inc = {};
  for (const it of items) {
    const f = it && fieldFor(it);
    if (f) inc[f] = (inc[f] || 0) + 1;
  }
  if (!Object.keys(inc).length) {
    // Nothing recognised. 204 rather than 400: the client is fire-and-forget
    // and must never be given a reason to retry or log noise.
    return { statusCode: 204, body: '' };
  }

  const db = getDb();
  if (!db) {
    console.error('Counter: Firebase Admin not initialized —', _initError);
    return { statusCode: 204, body: '' };   // never let analytics break a page
  }

  try {
    const payload = { day: today(), updatedAt: new Date().toISOString() };
    for (const [k, n] of Object.entries(inc)) {
      payload[k] = admin.firestore.FieldValue.increment(n);
    }
    await db.collection('counters').doc(today()).set(payload, { merge: true });
  } catch (err) {
    console.error('Counter write failed:', err.message);
  }
  return { statusCode: 204, body: '' };
};
