/**
 * Self-contained monitoring dashboard served at GET /dashboard.
 * It polls GET /stats (token usage tracked by this gateway) and GET /credits
 * (best-effort credit/quota info pulled from upstreams).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>multi-ai-provider-gateway — monitor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif;
         background: #0d1117; color: #e6edf3; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 20px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr));
           gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #161b22;
          border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .kiro { background: #1f6feb33; color: #79c0ff; }
  .copilot-api, .copilot { background: #23863633; color: #7ee787; }
  .err { color: #ff7b72; }
  h2 { font-size: 15px; margin: 24px 0 10px; color: #c9d1d9; }
  .muted { color: #6e7681; }
  .credit-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 12px; }
  a { color: #58a6ff; }
  .connect-btn { background:#238636; color:#fff; border:none; border-radius:6px;
                 padding:6px 12px; font-size:13px; cursor:pointer; }
  .connect-btn:hover { background:#2ea043; }
  .auth-info { margin-top:8px; font-size:13px; }
</style>
</head>
<body>
  <h1>multi-ai-provider-gateway</h1>
  <div class="sub">credits &amp; token monitor · auto-refresh every 4s · <span id="uptime" class="muted"></span></div>

  <div class="cards">
    <div class="card"><div class="label">Requests</div><div class="value" id="t-req">—</div></div>
    <div class="card"><div class="label">Errors</div><div class="value err" id="t-err">—</div></div>
    <div class="card"><div class="label">Input tokens</div><div class="value" id="t-in">—</div></div>
    <div class="card"><div class="label">Output tokens</div><div class="value" id="t-out">—</div></div>
    <div class="card"><div class="label">Total tokens</div><div class="value" id="t-tot">—</div></div>
    <div class="card"><div class="label">Est. spend</div><div class="value" id="t-cost">—</div></div>
  </div>

  <h2>Per-provider usage (this session)</h2>
  <div class="credit-grid" id="byprovider"><span class="muted">loading…</span></div>

  <h2>Credits &amp; quota (from upstreams)</h2>
  <div class="credit-grid" id="credits"><span class="muted">loading…</span></div>

  <h2>Per-model usage (this session)</h2>
  <table>
    <thead><tr>
      <th>Backend</th><th>Model</th>
      <th class="num">Reqs</th><th class="num">Errs</th>
      <th class="num">In</th><th class="num">Out</th><th class="num">Total</th>
      <th class="num">Est. $</th><th>Last used</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="9" class="muted">no requests yet</td></tr></tbody>
  </table>

<script>
const $ = id => document.getElementById(id);
const fmt = n => (n ?? 0).toLocaleString();
const money = n => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: n > 0 && n < 0.01 ? 4 : 2, maximumFractionDigits: 4 }));
const ago = iso => { if (!iso) return '—'; const s = Math.round((Date.now()-new Date(iso))/1000);
  return s<60? s+'s ago' : s<3600? Math.round(s/60)+'m ago' : Math.round(s/3600)+'h ago'; };
const when = iso => { try { return iso ? new Date(iso).toLocaleString() : '—'; } catch { return '—'; } };

// Friendly labels for the two providers.
const PROVIDERS = [
  { key: 'kiro-gateway', label: 'Kiro', cls: 'kiro', auth: 'kiro' },
  { key: 'copilot-api',  label: 'GitHub Copilot', cls: 'copilot-api', auth: 'copilot' },
];

function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

function renderTotals(s) {
  const t = s.totals || {};
  setText('t-req', fmt(t.requests));
  setText('t-err', fmt(t.errors));
  setText('t-in',  fmt(t.inputTokens));
  setText('t-out', fmt(t.outputTokens));
  setText('t-tot', fmt((t.inputTokens||0) + (t.outputTokens||0)));
  setText('t-cost', money(t.estCostUsd));
  setText('uptime', 'since ' + when(s.startedAt));
}

function renderByProvider(s) {
  const by = s.byBackend || {};
  $('byprovider').innerHTML = PROVIDERS.map(p => {
    const b = by[p.key] || { requests:0, errors:0, inputTokens:0, outputTokens:0, estCostUsd:0 };
    const total = (b.inputTokens||0) + (b.outputTokens||0);
    // Kiro spend is not metered per-token; show "—" instead of $0.
    const spend = p.key === 'kiro-gateway' ? '—' : money(b.estCostUsd);
    return \`<div class="card">
      <div class="label"><span class="pill \${p.cls}">\${p.label}</span></div>
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px 12px">
        <div class="muted">requests</div><div class="num">\${fmt(b.requests)}</div>
        <div class="muted">errors</div><div class="num \${b.errors?'err':''}">\${fmt(b.errors)}</div>
        <div class="muted">input tokens</div><div class="num">\${fmt(b.inputTokens)}</div>
        <div class="muted">output tokens</div><div class="num">\${fmt(b.outputTokens)}</div>
        <div class="muted">total tokens</div><div class="num"><b>\${fmt(total)}</b></div>
        <div class="muted">est. spend</div><div class="num"><b>\${spend}</b></div>
      </div>
    </div>\`;
  }).join('');
}

function renderQuotaLines(u) {
  const lines = [];
  if (u.plan) lines.push('<div class="muted">plan</div><div>' + u.plan + '</div>');
  if (u.tokenExpiresAt) lines.push('<div class="muted">token expires</div><div>' + when(u.tokenExpiresAt) + '</div>');
  if (u.quotaResetDate) lines.push('<div class="muted">quota resets</div><div>' + when(u.quotaResetDate) + '</div>');
  const snaps = u.quotaSnapshots || null;
  if (snaps && typeof snaps === 'object') {
    for (const [name, val] of Object.entries(snaps)) {
      if (val && typeof val === 'object') {
        const pretty = name.replace(/_/g, ' ');
        if (val.unlimited === true) {
          lines.push('<div class="muted">' + pretty + '</div><div class="num">unlimited</div>');
          continue;
        }
        // Prefer an explicit "used / entitlement" view when present (credits).
        const used = val.credits_used ?? val.used;
        const ent = val.entitlement ?? val.entitlement_remaining;
        const pct = val.percent_remaining;
        let show;
        if (ent != null && Number(ent) > 0) {
          show = fmt(used ?? 0) + ' / ' + fmt(ent) + (pct != null ? ' · ' + pct + '% left' : '');
        } else if (used != null) {
          show = fmt(used) + ' used';
        } else {
          const rem = val.remaining ?? val.remaining_count ?? val.quota_remaining;
          show = rem != null ? fmt(rem) + (pct != null ? ' (' + pct + '%)' : '')
               : (pct != null ? pct + '% left' : (val.has_quota === false ? 'n/a' : JSON.stringify(val)));
        }
        lines.push('<div class="muted">' + pretty + '</div><div class="num">' + show + '</div>');
      } else {
        lines.push('<div class="muted">' + name + '</div><div class="num">' + fmt(val) + '</div>');
      }
    }
  }
  return lines.length
    ? '<div style="margin-top:10px;display:grid;grid-template-columns:1fr auto;gap:4px 12px">' + lines.join('') + '</div>'
    : '';
}

function renderCredits(c) {
  const ups = (c && c.providers) || {};
  $('credits').innerHTML = PROVIDERS.map(p => {
    const u = ups[p.key] || { available: false };
    const authed = u.available !== false;
    let body;
    if (authed) {
      body = '<span class="pill ' + p.cls + '">authenticated</span>' + renderQuotaLines(u);
      if (p.key === 'kiro-gateway' && u.metered === false) {
        body += '<div class="auth-info muted">' + (u.detail || 'subscription — no per-token meter') + '</div>';
      }
    } else {
      body = '<div class="muted" style="margin-bottom:8px">not authenticated</div>'
        + '<button data-auth="' + p.auth + '" class="connect-btn">Connect ' + p.label + '</button>'
        + '<div class="auth-info" id="auth-' + p.auth + '"></div>';
    }
    return \`<div class="card"><div class="label">\${p.label}</div>\${body}</div>\`;
  }).join('');

  document.querySelectorAll('.connect-btn').forEach(btn => {
    btn.onclick = () => startAuth(btn.getAttribute('data-auth'));
  });
}

function renderModels(s) {
  const models = s.models || [];
  $('rows').innerHTML = models.length ? models.map(m => \`
    <tr>
      <td><span class="pill \${m.backend}">\${m.backend}</span></td>
      <td>\${m.model}</td>
      <td class="num">\${fmt(m.requests)}</td>
      <td class="num \${m.errors?'err':''}">\${fmt(m.errors)}</td>
      <td class="num">\${fmt(m.inputTokens)}</td>
      <td class="num">\${fmt(m.outputTokens)}</td>
      <td class="num">\${fmt((m.inputTokens||0)+(m.outputTokens||0))}</td>
      <td class="num">\${money(m.estCostUsd)}</td>
      <td class="muted">\${ago(m.lastUsed)}</td>
    </tr>\`).join('') : '<tr><td colspan="9" class="muted">no requests yet</td></tr>';
}

async function tick() {
  let s = null, c = { providers: {} };
  try { s = await fetch('/stats').then(r=>r.json()); }
  catch (e) { setText('uptime', 'stats fetch failed'); }
  try { c = await fetch('/credits').then(r=>r.json()); } catch (e) {}

  if (s) { renderTotals(s); renderByProvider(s); renderModels(s); }
  renderCredits(c);
}

async function startAuth(provider) {
  const info = $('auth-' + provider);
  if (info) info.textContent = 'starting…';
  try {
    const st = await fetch('/auth/' + provider + '/start', { method: 'POST' }).then(r => r.json());
    renderAuth(provider, st);
    const poll = setInterval(async () => {
      try {
        const s = await fetch('/auth/' + provider + '/status').then(r => r.json());
        renderAuth(provider, s);
        if (s.status === 'authorized' || s.status === 'error') { clearInterval(poll); setTimeout(tick, 500); }
      } catch (e) { /* keep polling */ }
    }, 3000);
  } catch (e) {
    if (info) info.textContent = 'failed to start auth';
  }
}

function renderAuth(provider, s) {
  const info = $('auth-' + provider);
  if (!info) return;
  if (s.status === 'pending') {
    const code = s.userCode && s.userCode !== '—'
      ? '<div style="margin:6px 0">enter code <b style="font-size:16px;letter-spacing:2px">' + s.userCode + '</b></div>' : '';
    const uri = /^https?:/.test(s.verificationUri || '')
      ? '<a href="' + s.verificationUri + '" target="_blank" rel="noopener">' + s.verificationUri + '</a>'
      : '<span class="muted">' + (s.verificationUri || '') + '</span>';
    info.innerHTML = code + '<div>' + uri + '</div><div class="muted" style="margin-top:4px">waiting for authorization…</div>';
  } else if (s.status === 'authorized') {
    info.innerHTML = '<span class="pill copilot-api">✓ ' + (s.message || 'authorized') + '</span>';
  } else if (s.status === 'error') {
    info.innerHTML = '<span class="err">' + (s.message || 'error') + '</span>';
  }
}

tick();
setInterval(tick, 4000);
</script>
</body>
</html>`;
