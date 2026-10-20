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
  </div>

  <h2>Credits &amp; quota (from upstreams)</h2>
  <div class="credit-grid" id="credits"><span class="muted">loading…</span></div>

  <h2>Per-model usage (this session)</h2>
  <table>
    <thead><tr>
      <th>Backend</th><th>Model</th>
      <th class="num">Reqs</th><th class="num">Errs</th>
      <th class="num">In</th><th class="num">Out</th><th class="num">Total</th><th>Last used</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="8" class="muted">no requests yet</td></tr></tbody>
  </table>

<script>
const fmt = n => (n ?? 0).toLocaleString();
const ago = iso => { if (!iso) return '—'; const s = Math.round((Date.now()-new Date(iso))/1000);
  return s<60? s+'s ago' : s<3600? Math.round(s/60)+'m ago' : Math.round(s/3600)+'h ago'; };

async function tick() {
  try {
    const [s, c] = await Promise.all([
      fetch('/stats').then(r=>r.json()),
      fetch('/credits').then(r=>r.json()).catch(()=>({providers:{}})),
    ]);
    const t = s.totals;
    t_req.textContent = fmt(t.requests);
    t_err.textContent = fmt(t.errors);
    t_in.textContent  = fmt(t.inputTokens);
    t_out.textContent = fmt(t.outputTokens);
    t_tot.textContent = fmt(t.inputTokens + t.outputTokens);
    uptime.textContent = 'since ' + new Date(s.startedAt).toLocaleString();

    rows.innerHTML = s.models.length ? s.models.map(m => \`
      <tr>
        <td><span class="pill \${m.backend}">\${m.backend}</span></td>
        <td>\${m.model}</td>
        <td class="num">\${fmt(m.requests)}</td>
        <td class="num \${m.errors?'err':''}">\${fmt(m.errors)}</td>
        <td class="num">\${fmt(m.inputTokens)}</td>
        <td class="num">\${fmt(m.outputTokens)}</td>
        <td class="num">\${fmt(m.inputTokens+m.outputTokens)}</td>
        <td class="muted">\${ago(m.lastUsed)}</td>
      </tr>\`).join('') : '<tr><td colspan="8" class="muted">no requests yet</td></tr>';

    const ups = c.providers || {};
    const keys = Object.keys(ups);
    credits.innerHTML = keys.length ? keys.map(k => {
      const u = ups[k];
      const body = u.available === false
        ? '<span class="muted">not reachable / no quota endpoint</span>'
        : '<pre style="margin:6px 0 0;white-space:pre-wrap;color:#adbac7;font-size:12px">'
          + (JSON.stringify(u.data, null, 2) || '{}') + '</pre>';
      return \`<div class="card"><div class="label">\${k}</div>\${body}</div>\`;
    }).join('') : '<span class="muted">no upstream credit data</span>';
  } catch (e) {
    uptime.textContent = 'stats fetch failed';
  }
}
tick(); setInterval(tick, 4000);
</script>
</body>
</html>`;
