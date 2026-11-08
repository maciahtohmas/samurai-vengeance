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
const SIMPLE = new Set(['arrived', 'menu', 'pad']);
const STAGED = new Set(['s_start', 's_clear', 'death', 'quit']);
const DIFFS  = new Set(['easy', 'normal', 'hard']);
// Which bucket a visitor fell into, derived on the client from storage the
// game already keeps for the streak feature. 'same' = a second session today.
const KINDS  = new Set(['new', 'same', 'd1', 'd7', 'old']);
// Traffic source, bucketed on the client so only a known token ever arrives.
// How a player got past the splash: its button, a tap anywhere else on it, or
// one of the consent bar's buttons (which now carry on into the game).
const ENTERS = new Set(['play', 'tap', 'key', 'accept', 'decline']);
// How long someone sat on the splash before leaving without entering.
const LEAVES = new Set(['s3', 's10', 's30', 'long']);
// Interactive tutorial: shown, each step completed, finished, skipped, and
// replayed from the menu. Where 'shown' and 'move' diverge is the first wall.
const TUTS   = new Set(['shown', 'move', 'jump', 'attack', 'parry', 'dash', 'clear', 'done', 'skip', 'replay']);
// Billfiti Studios follow buttons: which platform, and which screen.
const SOCIALS = new Set(['tiktok', 'instagram', 'youtube', 'discord', 'x', 'bluesky']);
const SOCIAL_AT = new Set(['menu', 'revive', 'gameover', 'stage']);
const SRCS   = new Set(['reddit', 'hn', 'google', 'search', 'itch', 'youtube',
                        'tiktok', 'social', 'discord', 'portal', 'internal',
                        'direct', 'other', 'app', 'share']);

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
  if (e === 'src') {
    const k = String(body.k || '');
    return SRCS.has(k) ? 's_src_' + k : null;
  }
  if (e === 'leave') {
    const k = String(body.k || '');
    return LEAVES.has(k) ? 'leave_' + k : null;
  }
  if (e === 'enter') {
    const k = String(body.k || '');
    return ENTERS.has(k) ? 'enter_' + k : null;
  }
  if (e === 'social') {
    const k = String(body.k || '');
    return SOCIALS.has(k) ? 'soc_' + k : null;
  }
  if (e === 'social_at') {
    const k = String(body.k || '');
    return SOCIAL_AT.has(k) ? 'soc_at_' + k : null;
  }
  if (e === 'ad') {
    // kind_status, e.g. next_viewed, reward_dismissed, next_notReady
    const k = String(body.k || '');
    return /^(next|reward)_[A-Za-z]{2,20}$/.test(k) ? 'ad_' + k : null;
  }
  if (e === 'tut') {
    const k = String(body.k || '');
    return TUTS.has(k) ? 'tut_' + k : null;
  }
  if (e === 'visitor') {
    const k = String(body.k || '');
    return KINDS.has(k) ? 'v_' + k : null;
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


// 30-day trend chart: inline SVG plus a small hover script, no libraries.
// Two series on one shared count axis. Colors were checked for colorblind
// separation and lightness against the card surface (#160a12).
function renderTrend(days) {
  const pts = days.slice().reverse().map(d => {
    const g = k => d.data[k] || 0;
    return { id: d.id, a: g('arrived'), p: g('start_easy') + g('start_normal') + g('start_hard') };
  });
  // Skip the empty days before counting began, so the line starts at real data.
  while (pts.length > 1 && !pts[0].a && !pts[0].p) pts.shift();
  if (!pts.some(x => x.a || x.p)) return '';
  const W = 380, H = 210, L = 28, R = 66, T = 12, B = 24;
  const iw = W - L - R, ih = H - T - B, n = pts.length;
  const max = Math.max(...pts.map(x => Math.max(x.a, x.p)));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(s => max / s <= 4) || 10000;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const X = i => L + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = v => T + ih - (v / top) * ih;
  const path = k => pts.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x[k]).toFixed(1)).join('');
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line x1="${L}" x2="${L + iw}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/>` +
      `<text x="${L - 6}" y="${Y(v) + 4}" class="ax" text-anchor="end">${v}</text>`;
  }
  const fmt = id => { const [, m, d] = id.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + ' ' + (+d); };
  let xl = '';
  pts.forEach((x, i) => { if ((n - 1 - i) % 10 === 0) xl += `<text x="${X(i)}" y="${H - 6}" class="ax" text-anchor="middle">${fmt(x.id)}</text>`; });
  const last = pts[n - 1], li = n - 1;
  let ly1 = Y(last.a), ly2 = Y(last.p);
  if (Math.abs(ly1 - ly2) < 14) { if (ly1 <= ly2) { ly1 -= 7; ly2 += 7; } else { ly1 += 7; ly2 -= 7; } }
  const data = JSON.stringify(pts.map(x => [fmt(x.id), x.a, x.p]));
  const rows = pts.slice().reverse().map(x => `<tr><th>${esc(fmt(x.id))}</th><td>${x.a}</td><td>${x.p}</td></tr>`).join('');
  return `<section class="trend">
  <h2>LAST ${n} DAYS</h2>
  <div class="lg"><span><i style="background:#b08d2e"></i>Arrived</span><span><i style="background:#5b8fe0"></i>Started a run</span></div>
  <div class="cw"><svg id="tc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily visitors and runs started, last ${n} days">
    ${grid}${xl}
    <path d="${path('a')}" class="ln" stroke="#b08d2e"/>
    <path d="${path('p')}" class="ln" stroke="#5b8fe0"/>
    <circle cx="${X(li)}" cy="${Y(last.a)}" r="4" fill="#b08d2e" stroke="#160a12" stroke-width="2"/>
    <circle cx="${X(li)}" cy="${Y(last.p)}" r="4" fill="#5b8fe0" stroke="#160a12" stroke-width="2"/>
    <text x="${X(li) + 9}" y="${ly1 + 4}" class="dl">${last.a} arrived</text>
    <text x="${X(li) + 9}" y="${ly2 + 4}" class="dl">${last.p} started</text>
    <line id="tx" y1="${T}" y2="${T + ih}" class="xh" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" id="th"/>
  </svg><div id="tt" class="tt" hidden></div></div>
  <details><summary>Show as a table</summary><table class="walls"><thead><tr><th></th><th>arrived</th><th>started</th></tr></thead><tbody>${rows}</tbody></table></details>
  <script>(()=>{const D=${data},n=D.length,L=${L},iw=${iw},W=${W};const s=document.getElementById('tc'),h=document.getElementById('th'),x=document.getElementById('tx'),t=document.getElementById('tt');
  function mv(e){const r=s.getBoundingClientRect(),c=e.touches?e.touches[0]:e,vx=(c.clientX-r.left)/r.width*W;const i=Math.max(0,Math.min(n-1,Math.round((vx-L)/iw*(n-1))));const px=L+(n===1?iw/2:i/(n-1)*iw);
  x.setAttribute('x1',px);x.setAttribute('x2',px);x.setAttribute('visibility','visible');const d=D[i];t.innerHTML='<b>'+d[0]+'</b><br><i style="background:#b08d2e"></i>'+d[1]+' arrived<br><i style="background:#5b8fe0"></i>'+d[2]+' started a run';t.hidden=false;
  const left=px/W*r.width;t.style.left=Math.min(Math.max(left-70,0),r.width-140)+'px';}
  function out(){x.setAttribute('visibility','hidden');t.hidden=true;}
  h.addEventListener('mousemove',mv);h.addEventListener('touchstart',mv,{passive:true});h.addEventListener('touchmove',mv,{passive:true});h.addEventListener('mouseleave',out);})();</script>
</section>`;
}

function renderReport(days, trendDays, extraTop) {
  const row = (label, n, base) => {
    const pct = base ? Math.round((n / base) * 100) : null;
    const w = base ? Math.max(1.5, (n / base) * 100) : 0;
    return `<tr><th>${esc(label)}</th><td class="n">${n}</td>
      <td class="pct">${pct === null ? '' : pct + '%'}</td>
      <td class="bar"><span style="width:${w}%"></span></td></tr>`;
  };

  const blocks = days.map((d, di) => {
    const prev = days[di + 1];
    const g = k => d.data[k] || 0;
    const arrived = g('arrived');
    const started = g('start_easy') + g('start_normal') + g('start_hard');

    const funnel = [
      row('Arrived', arrived, arrived),
      row('Got past the splash', g('menu'), arrived),
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

    const vNew = g('v_new'), vD1 = g('v_d1'), vD7 = g('v_d7'), vOld = g('v_old');
    const returning = vD1 + vD7 + vOld;
    const known = vNew + returning;
    // A real cohort D1: of the people new YESTERDAY, how many came back today.
    const prevNew = prev ? (prev.data.v_new || 0) : 0;
    const d1rate = prevNew ? Math.round((vD1 / prevNew) * 100) : null;

    const SRC_LABEL = {
      reddit:'Reddit', hn:'Hacker News', google:'Google', search:'Other search',
      itch:'itch.io', youtube:'YouTube', tiktok:'TikTok', social:'Social',
      discord:'Discord', portal:'Game portals', internal:'Another page here',
      direct:'Direct / untagged', other:'Elsewhere', app:'Home screen app', share:'Shared by a player',
    };
    const srcs = Object.keys(SRC_LABEL)
      .map(k => ({ k, n: g('s_src_' + k) }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n);
    const srcTotal = srcs.reduce((t, x) => t + x.n, 0);
    const srcBlock = srcTotal ? `<h3>Where they came from</h3>
      <table class="funnel"><tbody>${srcs.map(x => {
        const w = Math.max(1.5, (x.n / srcTotal) * 100);
        return `<tr><th>${esc(SRC_LABEL[x.k])}</th><td class="n">${x.n}</td>
          <td class="pct">${Math.round((x.n / srcTotal) * 100)}%</td>
          <td class="bar"><span style="width:${w}%"></span></td></tr>`;
      }).join('')}</tbody></table>` : '';

    const retBlock = known ? `<h3>Who showed up</h3>
      <table class="walls"><tbody>
        <tr><th>First time</th><td class="n">${vNew}</td>
            <td class="pct">${Math.round((vNew / known) * 100)}%</td></tr>
        <tr><th>Back after a day</th><td class="n">${vD1}</td>
            <td class="pct">${Math.round((vD1 / known) * 100)}%</td></tr>
        <tr><th>Back within a week</th><td class="n">${vD7}</td>
            <td class="pct">${Math.round((vD7 / known) * 100)}%</td></tr>
        <tr><th>Back after longer</th><td class="n">${vOld}</td>
            <td class="pct">${Math.round((vOld / known) * 100)}%</td></tr>
      </tbody></table>
      ${d1rate === null ? '' : `<p class="note">Day-1 return: <b>${d1rate}%</b>
        &mdash; ${vD1} of the ${prevNew} who arrived for the first time yesterday.
        A healthy game sits near 40%.</p>`}` : '';

    // Splash exits and tutorial steps. Both shipped 12 Oct, so earlier days
    // show nothing here.
    const ENTER_LABEL = { play: 'Tapped PLAY NOW', tap: 'Tapped elsewhere on the splash', key: 'Pressed a key',
      accept: 'Tapped Accept on the consent bar', decline: 'Tapped Decline on the consent bar' };
    const enters = Object.keys(ENTER_LABEL).map(k => ({ k, n: g('enter_' + k) })).filter(x => x.n);
    const enterTotal = enters.reduce((t, x) => t + x.n, 0);
    const enterBlock = enterTotal ? `<h3>How they got past the splash</h3>
      <table class="walls"><tbody>${enters.map(x => `<tr><th>${esc(ENTER_LABEL[x.k])}</th>
        <td class="n">${x.n}</td><td class="pct">${Math.round((x.n / enterTotal) * 100)}%</td></tr>`).join('')}
      </tbody></table>` : '';
    const LEAVE_LABEL = { s3: 'Under 3 seconds', s10: '3 to 10 seconds', s30: '10 to 30 seconds', long: 'Over 30 seconds' };
    const leaves = Object.keys(LEAVE_LABEL).map(k => ({ k, n: g('leave_' + k) })).filter(x => x.n);
    const leaveBlock = leaves.length ? `<h3>Left on the splash, after</h3>
      <table class="walls"><tbody>${leaves.map(x => `<tr><th>${esc(LEAVE_LABEL[x.k])}</th><td class="n">${x.n}</td></tr>`).join('')}</tbody></table>
      <p class="note">Includes people who switched apps and came back later.</p>` : '';
    const tShown = g('tut_shown');
    const TUT_ROWS = [['Saw the tutorial', 'shown'], ['Moved', 'move'], ['Jumped', 'jump'],
      ['Defeated an enemy', 'attack'], ['Landed a parry', 'parry'], ['Dashed', 'dash'], ['Cleared the stage', 'clear'], ['Finished it', 'done']];
    const tutBlock = tShown ? `<h3>Tutorial</h3>
      <table class="funnel"><tbody>${TUT_ROWS.map(([l, k]) => row(l, g('tut_' + k), tShown)).join('')}</tbody></table>
      <p class="note">${g('tut_skip')} skipped it. ${g('tut_replay')} replayed it from the menu.</p>` : '';

    const SOC_LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube',
      discord: 'Discord', x: 'X', bluesky: 'Bluesky' };
    const AT_LABEL = { menu: 'menu', revive: 'revive screen', gameover: 'game over', stage: 'stage clear' };
    const socs = Object.keys(SOC_LABEL).map(k => ({ k, n: g('soc_' + k) })).filter(x => x.n);
    const ats = Object.keys(AT_LABEL).map(k => ({ k, n: g('soc_at_' + k) })).filter(x => x.n);
    const socBlock = socs.length ? `<h3>Follow clicks</h3>
      <table class="walls"><tbody>${socs.map(x => `<tr><th>${esc(SOC_LABEL[x.k])}</th><td class="n">${x.n}</td></tr>`).join('')}</tbody></table>
      <p class="note">From: ${ats.map(x => `${esc(AT_LABEL[x.k])} ${x.n}`).join(', ')}</p>` : '';

    return `<section>
      <h2>${esc(d.id)}</h2>
      ${arrived ? `<table class="funnel">${funnel}</table>` : '<p class="empty">No traffic recorded.</p>'}
      ${diffs ? `<ul class="diffs">${diffs}</ul>` : ''}
      ${g('pad') ? `<p class="note">${g('pad')} connected a game controller.</p>` : ''}
      ${enterBlock}
      ${leaveBlock}
      ${tutBlock}
      ${socBlock}
      ${srcBlock}
      ${retBlock}
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
.note{font-size:12px;color:var(--dim);line-height:1.65;margin:10px 0 0;}
.note b{color:var(--gold);font-size:14px;}
.trend .lg{display:flex;gap:18px;font-size:12.5px;color:var(--dim);margin:0 0 6px;}
.lg i,.tt i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;}
.cw{position:relative;}
#tc{width:100%;height:auto;display:block;touch-action:pan-y;}
#tc .gl{stroke:rgba(240,228,200,.08);stroke-width:1;}
#tc .ax{fill:var(--dim);font:10px Georgia,serif;}
#tc .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;}
#tc .dl{fill:var(--ink);font:10.5px Georgia,serif;}
#tc .xh{stroke:rgba(240,228,200,.35);stroke-width:1;}
.tt{position:absolute;top:4px;width:140px;background:#0d0409;border:1px solid var(--line);border-radius:3px;padding:6px 8px;font-size:12px;line-height:1.5;pointer-events:none;}
.trend details{margin-top:10px;font-size:12px;color:var(--dim);}
.trend summary{cursor:pointer;}
footer{color:var(--dim);font-size:11.5px;line-height:1.7;margin-top:22px;}
</style></head><body>
<h1>Player funnel</h1>
<p class="sub">Samurai Vengeance &middot; last ${days.length} days &middot; Pacific</p>
${renderTrend(trendDays || days)}
${extraTop || ''}
${blocks}
<footer>Counts only &mdash; no cookies, no identifiers, nothing stored on any
visitor's device. Fires for every visitor, not just those who accept the
consent banner.</footer>
</body></html>`;
}

const DIFFS_ORDER = ['easy', 'normal', 'hard'];
const DIFF_LABEL = { easy: 'on Peace', normal: 'on Warrior', hard: 'on Demon' };

// ── Handler ──────────────────────────────────────────────────────
// ── Weekly champions ─────────────────────────────────────────────
// The weekly leaderboard stores each player's best for a week under fields
// like wk2026w45_stage on leaderboard/{uid}. The owner crowns a winner from
// the stats page; the list lives in meta/champions and is read through this
// function (the Admin SDK), so no Firestore rule change is needed and players
// cannot crown themselves.
function wkKey(d) {
  d = d || new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return 'wk' + y + 'w' + String(w).padStart(2, '0');
}
async function readChampions(db) {
  const s = await db.collection('meta').doc('champions').get();
  const d = s.exists ? s.data() : {};
  return { history: Array.isArray(d.history) ? d.history : [], stages: d.stages || {} };
}
async function topForWeek(db, wk) {
  try {
    const q = await db.collection('leaderboard').orderBy(wk + '_stage', 'desc').limit(5).get();
    return q.docs.map(x => {
      const v = x.data();
      return { uid: x.id, name: String(v.name || 'Warrior').slice(0, 40), stage: v[wk + '_stage'] || 0,
        combo: v[wk + '_combo'] || 0, kills: v[wk + '_kills'] || 0, allTime: v.stage || 0 };
    });
  } catch (e) { return []; }
}
function renderChampionAdmin(key, lastWk, thisWk, lastTop, thisTop, champs) {
  const crowned = new Set(champs.history.map(h => h.week));
  const rows = (list, wk, canCrown) => list.length ? list.map((r, i) => `<tr><th>${i + 1}. ${esc(r.name)}</th>
      <td class="n">${r.stage}</td><td class="n">&times;${r.combo}</td><td class="n">${r.allTime}</td>
      <td>${canCrown && !crowned.has(wk) ? `<form method="post" action="?key=${encodeURIComponent(key)}&action=crown" style="margin:0">
        <input type="hidden" name="uid" value="${esc(r.uid)}"><input type="hidden" name="week" value="${wk}">
        <button style="font:inherit;font-size:11px;padding:2px 8px;background:#2a1a10;color:var(--gold);border:1px solid var(--line);border-radius:3px">Crown</button></form>` : ''}</td></tr>`).join('')
    : '<tr><th class="empty">No weekly scores yet.</th></tr>';
  const head = '<thead><tr><th></th><th>stage</th><th>combo</th><th>all-time</th><th></th></tr></thead>';
  const hist = champs.history.slice().reverse().slice(0, 8).map(h =>
    `<tr><th>${esc(h.week)}</th><td>${esc(h.name)}</td><td class="n">${h.stage}</td></tr>`).join('');
  const stages = Object.keys(champs.stages).map(k => `${esc(k)}: ${esc(champs.stages[k])}`).join(', ');
  return `<section>
  <h2>WEEKLY CHAMPION</h2>
  <h3>Last week (${lastWk}) ${crowned.has(lastWk) ? '&middot; crowned' : ''}</h3>
  <table class="walls">${head}<tbody>${rows(lastTop, lastWk, true)}</tbody></table>
  <p class="note">Before crowning, check the score looks believable: compare the weekly stage with the all-time column, and be wary of a brand-new account far ahead of everyone.</p>
  <h3>This week so far (${thisWk})</h3>
  <table class="walls">${head}<tbody>${rows(thisTop, thisWk, false)}</tbody></table>
  ${hist ? `<h3>Past champions</h3><table class="walls"><tbody>${hist}</tbody></table>` : ''}
  <h3>Name a stage (monthly prize)</h3>
  <form method="post" action="?key=${encodeURIComponent(key)}&action=stage" style="display:flex;gap:6px;flex-wrap:wrap">
    <input name="stage" inputmode="numeric" placeholder="Stage" style="width:70px">
    <input name="name" placeholder="Player name" maxlength="24" style="flex:1;min-width:120px">
    <button style="font:inherit;padding:2px 10px">Save</button></form>
  <p class="note">${stages ? 'Named so far: ' + stages : 'No stages named yet.'} Leave the name empty to clear a stage.</p>
</section>`;
}
function parseForm(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const o = {}; new URLSearchParams(raw).forEach((v, k) => { o[k] = v; }); return o;
}

// ── Crash reports ────────────────────────────────────────────────
// The game sends {e:'err', m, w, s, lv} for uncaught errors. They are kept
// per day in errors/{day}, one entry per distinct message and location, with
// a count and a coarse browser bucket derived from the user agent here (the
// user agent itself is not stored). Capped at 40 distinct entries a day so
// the public endpoint cannot be used to grow the document without limit.
const crypto = require('crypto');
function uaBucket(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux|CrOS/.test(ua) ? 'Linux' : 'Other';
  const br = /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook app' : /musical_ly|TikTok|BytedanceWebview/i.test(ua) ? 'TikTok app'
    : /Instagram/.test(ua) ? 'Instagram app' : /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  return os + ' ' + br;
}
async function recordErrors(db, errs, ua) {
  const ref = db.collection('errors').doc(today());
  const snap = await ref.get();
  const have = snap.exists ? snap.data() : {};
  const n = Object.keys(have).filter(k => k.startsWith('e_')).length;
  const payload = {};
  const b = uaBucket(ua).replace(/[^\w ]/g, '');
  for (const it of errs) {
    const m = String(it.m || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 160);
    if (!m) continue;
    const w = String(it.w || '').replace(/[^\w :.-]/g, '').slice(0, 40);
    const st = /^[a-z]{1,12}$/.test(it.s || '') ? it.s : 'other';
    const lv = Math.max(0, Math.min(1000, Math.floor(Number(it.lv) || 0)));
    const h = 'e_' + crypto.createHash('sha1').update(m + '|' + w).digest('hex').slice(0, 12);
    if (!have[h] && n + Object.keys(payload).length >= 40) continue;
    const inc = admin.firestore.FieldValue.increment(1);
    payload[h] = { m, w, n: inc, br: { [b]: inc }, st: { [st]: inc }, lv, last: new Date().toISOString() };
  }
  if (Object.keys(payload).length) await ref.set(payload, { merge: true });
}
function renderErrors(errDays) {
  const all = {};
  for (const d of errDays) {
    for (const [k, v] of Object.entries(d.data || {})) {
      if (!k.startsWith('e_') || !v) continue;
      const a = all[k] || (all[k] = { m: v.m, w: v.w, n: 0, br: {}, st: {}, last: '', lv: 0, days: 0 });
      a.n += v.n || 0; a.days++;
      for (const [x, c] of Object.entries(v.br || {})) a.br[x] = (a.br[x] || 0) + c;
      for (const [x, c] of Object.entries(v.st || {})) a.st[x] = (a.st[x] || 0) + c;
      if ((v.last || '') > a.last) { a.last = v.last; a.lv = v.lv; }
    }
  }
  const list = Object.values(all).sort((a, b) => b.n - a.n).slice(0, 12);
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, c]) => `${esc(k)} ${c}`).join(', ');
  return `<section>
  <h2>CRASHES AND ERRORS &middot; LAST 7 DAYS</h2>
  ${list.length ? `<table class="walls"><thead><tr><th>error</th><th>times</th></tr></thead><tbody>${list.map(e =>
    `<tr><th style="font-size:12.5px;line-height:1.45;padding-right:8px">${esc(e.m)}<br><span style="color:var(--dim);font-size:11px">${esc(e.w || 'unknown place')} &middot; ${top(e.br)} &middot; while ${top(e.st)}${e.lv ? ' &middot; last on stage ' + e.lv : ''}</span></th><td class="n">${e.n}</td></tr>`).join('')}</tbody></table>
  <p class="note">Send a screenshot of this section to Claude to get a fix. Each line is one distinct error; the grey text says where in the game file it happened, which browsers hit it, and what the player was doing.</p>`
  : '<p class="empty">No errors reported. Good.</p>'}
</section>`;
}

exports.handler = async (event) => {
  // ---- READ ----
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).champions) {
    const db = getDb();
    if (!db) return { statusCode: 503, body: '{}' };
    const c = await readChampions(db);
    return { statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({ current: c.history[c.history.length - 1] || null, history: c.history, stages: c.stages }) };
  }
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
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 86400000);
      ids.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
    }
    const snaps = await db.getAll(...ids.map(id => db.collection('counters').doc(id)));
    const days = snaps.map((s, i) => ({ id: ids[i], data: s.exists ? s.data() : {} }));

    let errHtml = '';
    try {
      const es = await db.getAll(...ids.slice(0, 7).map(id => db.collection('errors').doc(id)));
      errHtml = renderErrors(es.map(x => ({ data: x.exists ? x.data() : {} })));
    } catch (e) { errHtml = ''; }
    const thisWk = wkKey(), lastWk = wkKey(new Date(Date.now() - 7 * 864e5));
    const [champs, lastTop, thisTop] = await Promise.all([readChampions(db), topForWeek(db, lastWk), topForWeek(db, thisWk)]);
    const admin = renderChampionAdmin(key, lastWk, thisWk, lastTop, thisTop, champs);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: renderReport(days.slice(0, 7), days, errHtml).replace('<footer>', admin + '\n<footer>'),
    };
  }

  // ---- WRITE ----
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Owner actions from the stats page: crown a weekly champion, name a stage.
  const qs = event.queryStringParameters || {};
  if (qs.action) {
    const want = process.env.COUNTER_KEY || '';
    if (!want || qs.key !== want) return { statusCode: 404, body: 'Not found' };
    const db = getDb();
    if (!db) return { statusCode: 500, body: 'Counter unavailable: ' + _initError };
    const f = parseForm(event);
    const ref = db.collection('meta').doc('champions');
    if (qs.action === 'crown' && f.uid && /^wk\d{4}w\d{2}$/.test(f.week || '')) {
      const lb = await db.collection('leaderboard').doc(f.uid).get();
      if (lb.exists) {
        const v = lb.data();
        await db.runTransaction(async tx => {
          const cur = await tx.get(ref);
          const h = (cur.exists && Array.isArray(cur.data().history)) ? cur.data().history : [];
          if (!h.some(x => x.week === f.week)) {
            h.push({ week: f.week, uid: f.uid, name: String(v.name || 'Warrior').slice(0, 40),
              stage: v[f.week + '_stage'] || 0, combo: v[f.week + '_combo'] || 0, at: new Date().toISOString() });
            tx.set(ref, { history: h.slice(-200) }, { merge: true });
          }
        });
      }
    } else if (qs.action === 'stage') {
      const n = Math.floor(Number(f.stage));
      if (n >= 1 && n <= 1000) {
        const name = String(f.name || '').replace(/[<>]/g, '').trim().slice(0, 24);
        await ref.set({ stages: { [String(n)]: name ? name : admin.firestore.FieldValue.delete() } }, { merge: true });
      }
    }
    return { statusCode: 303, headers: { Location: '/api/count?key=' + encodeURIComponent(qs.key) }, body: '' };
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
  const errs = items.filter(it => it && it.e === 'err').slice(0, 5);
  const inc = {};
  for (const it of items) {
    const f = it && fieldFor(it);
    if (f) inc[f] = (inc[f] || 0) + 1;
  }
  if (errs.length) {
    const db0 = getDb();
    if (db0) {
      try { await recordErrors(db0, errs, (event.headers || {})['user-agent']); }
      catch (err) { console.error('Error report write failed:', err.message); }
    }
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
