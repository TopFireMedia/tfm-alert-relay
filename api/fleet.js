import { kvMGet, kvSMembers, kvConfigured, kvDel, kvSRem, kvGet } from '../lib/kv.js';

export default async function handler(req, res) {
  try {
    return await render(req, res);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send(
      `<!doctype html><meta charset="utf-8"><title>TFM Fleet Monitor — unavailable</title>` +
      `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.5rem">` +
      `<h1 style="font-size:1.2rem">Monitoring data is unavailable</h1>` +
      `<p>The dashboard could not read from its datastore. The fleet itself is unaffected — sites keep sending heartbeats, and this page will recover on its own once the datastore does.</p>` +
      `<pre style="background:#f5f6f8;padding:.85rem 1rem;border-radius:8px;overflow-x:auto;font-size:.85rem">${esc(msg)}</pre>` +
      `<p style="color:#6b7280;font-size:.9rem">A <code>KV 4xx</code> above usually means the Upstash plan limit has been reached or the credentials changed.</p></div>`
    );
  }
}

async function render(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  const key = req.query.key || '';
  if (token) {
    const cookieTok = getCookie(req, 'tfm_dash');
    if (key === token) {
      // Fresh auth via ?key — stash it in an HttpOnly cookie so the token stops
      // living in the address bar, browser history, and outbound referrers, then
      // strip it from the URL. API/remove calls just proceed.
      res.setHeader('Set-Cookie', `tfm_dash=${encodeURIComponent(token)}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      if (!req.query.remove && req.query.format !== 'json') {
        res.statusCode = 302;
        res.setHeader('Location', '/api/fleet');
        return res.end();
      }
    } else if (cookieTok !== token) {
      return res.status(401).send('Unauthorized — append ?key=YOUR_TOKEN');
    }
  }
  if (!kvConfigured()) return res.status(500).send('KV not configured');

  if (req.query.remove) {
    const host = String(req.query.remove).toLowerCase();
    await kvDel(`site:${host}`);
    await kvSRem('sites', host);
    if (req.query.format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify({ ok: true, removed: host }));
    }
    const back = `/api/fleet${token ? `?key=${encodeURIComponent(key)}` : ''}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`Removed <code>${esc(host)}</code>. <a href="${esc(back)}">Back to the dashboard</a>.`);
  }

  const hosts = await kvSMembers('sites');
  const now = Date.now();
  const rows = (hosts.length ? await kvMGet(hosts.map(h => `site:${h}`)) : []).filter(Boolean);
  rows.sort((a, b) => (decodeEntities(a.site_name) || '').localeCompare(decodeEntities(b.site_name) || ''));

  // "On our server" — matched against the authoritative Plesk host list (fed to
  // KV by the server cron via /api/onserver). Keyed to hostnames, not raw IP, so
  // Cloudflare-proxied sites hosted on our box are still recognised as ours.
  const onServerRaw = await kvGet('on_server_hosts');
  const onServerSet = new Set((Array.isArray(onServerRaw) ? onServerRaw : []).map(normHost));
  const serverKnown = onServerSet.size > 0;
  const onServer = (host) => onServerSet.has(normHost(host));

  if (req.query.format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(rows, null, 2));
  }

  const STALE = 45 * 60 * 1000;
  const statusOf = (r) => (r.status === 'down' ? 'down' : ((now - (r.last_seen || 0)) > STALE ? 'stale' : 'up'));
  const hasCustom = (r) => !!(r.custom_scripts && (r.custom_scripts.head || r.custom_scripts.footer));
  const hasScf = (r) => !!r.scf_active;
  const sslSoon = (r) => typeof r.ssl_days_left === 'number' && r.ssl_days_left < 30;
  const versions = rows.map(r => r.plugin_version).filter(Boolean);
  const latest = versions.slice().sort(cmpVer).pop() || '';
  const nDev = rows.filter(r => isDev(hostOf(r.site_url))).length;
  const nClient = rows.length - nDev;
  const nUp = rows.filter(r => statusOf(r) === 'up').length;
  const nDown = rows.filter(r => statusOf(r) === 'down').length;
  const nStale = rows.filter(r => statusOf(r) === 'stale').length;
  const nVer = new Set(versions).size;
  const nOutdated = rows.filter(r => r.plugin_version && latest && cmpVer(r.plugin_version, latest) < 0).length;
  const nCustom = rows.filter(hasCustom).length;
  const nScf = rows.filter(hasScf).length;
  const nIndexOff = rows.filter(r => r.search_indexing === false).length;
  const nUpdIssue = rows.filter(r => r.auto_update === false || r.update_token_set === true).length;
  const nSsl = rows.filter(sslSoon).length;
  const nServer = rows.filter(r => onServer(hostOf(r.site_url))).length;

  const rowsHtml = rows.map(r => {
    const st = statusOf(r);
    const label = st === 'down' ? 'Down' : (st === 'stale' ? 'Stale' : 'Up');
    const host = hostOf(r.site_url);
    const dev = isDev(host);
    const srv = serverKnown ? onServer(host) : null;
    const name = decodeEntities(r.site_name);
    const outdated = r.plugin_version && latest && cmpVer(r.plugin_version, latest) < 0;
    const ver = esc(r.plugin_version || '—');
    const verCell = `<span class="ver ${outdated ? 'ver-old' : 'ver-cur'}"${outdated ? ` title="Behind latest (${esc(latest)})"` : ''}>${ver}${outdated ? ' &#9650;' : ''}</span>`;

    const eol = phpEol(r.php_version);
    const stackCell = `<span class="${eol ? 'php-eol' : 'c-mut'}"${eol ? ` title="PHP ${esc(r.php_version)} is end-of-life — upgrade the server PHP"` : ''}>${esc(r.php_version || '—')}</span><span class="c-faint"> / ${esc(r.wp_version || '—')}</span>`;

    const sd = r.ssl_days_left;
    const sslCell = (typeof sd === 'number')
      ? (sd < 0 ? `<span class="tag tag-bad" title="Certificate EXPIRED ${-sd} day(s) ago">Expired</span>`
        : sd < 15 ? `<span class="tag tag-bad" title="Certificate expires in ${sd} day(s)">${sd}d</span>`
        : sd < 30 ? `<span class="tag tag-warn" title="Certificate expires in ${sd} day(s)">${sd}d</span>`
        : `<span class="c-mut" title="Certificate valid for ${sd} more day(s)">${sd}d</span>`)
      : `<span class="c-mut">&mdash;</span>`;

    const cc = hasCustom(r);
    const ccCell = cc
      ? `<span class="tag tag-warn" title="Head: ${r.custom_scripts.head ? 'yes' : 'no'} · Footer: ${r.custom_scripts.footer ? 'yes' : 'no'}">Yes · ${fmtBytes(r.custom_scripts.total_bytes || 0)}</span>`
      : `<span class="c-mut">&mdash;</span>`;
    const scf = hasScf(r);
    const scfCell = scf
      ? `<span class="tag tag-info" title="Secure Custom Fields / ACF is active">Active</span>`
      : `<span class="c-mut">&mdash;</span>`;
    const idx = r.search_indexing;
    const idxCell = idx === false
      ? `<span class="tag tag-bad" title="Search engines discouraged — this site is set to noindex">Off</span>`
      : (idx === true ? `<span class="c-ok">On</span>` : `<span class="c-mut">&mdash;</span>`);

    const cons = (r.cookie_consent && typeof r.cookie_consent === 'object') ? r.cookie_consent : null;
    const csys = cons ? cons.system : undefined;
    const consentCell = (csys === undefined)
      ? `<span class="c-mut">&mdash;</span>`
      : (csys === 'tracking'
          ? (cons.enforcing
              ? `<span class="tag tag-info" title="Tracking Consent active and enforcing the visitor's choice">Tracking</span>`
              : `<span class="tag tag-warn" title="A consent banner is shown but nothing enforces the choice">Banner only</span>`)
          : `<span class="c-mut" title="No consent banner on this site">Off</span>`);

    const au = r.auto_update, tok = r.update_token_set;
    const updIssue = au === false || tok === true;
    const updCell = au === false
      ? `<span class="tag tag-bad" title="Auto-update is OFF${tok ? ' · a GitHub token is also set' : ''}">Auto off</span>`
      : (tok === true
          ? `<span class="tag tag-warn" title="A GitHub token is set — can 401 against the public repo and block update checks">Token set</span>`
          : (au === true ? `<span class="c-ok">Auto</span>` : `<span class="c-mut">&mdash;</span>`));

    const adminUrl = (r.admin_url && String(r.admin_url)) || (String(r.site_url || '').replace(/\/+$/, '') + '/wp-admin/');
    const filterKey = esc((name + ' ' + host).toLowerCase());
    const srvBadge = srv === null ? ''
      : (srv ? ' <span class="ptag ptag-srv" title="Hosted on our Plesk server">ours</span>'
             : ' <span class="ptag ptag-ext" title="Hosted elsewhere — not on our server">ext</span>');
    return `<tr data-host="${esc(host)}" data-type="${dev ? 'dev' : 'client'}" data-server="${srv ? '1' : '0'}" data-status="${st}" data-ver="${esc(r.plugin_version || '')}" data-custom="${cc ? '1' : '0'}" data-scf="${scf ? '1' : '0'}" data-index="${idx === false ? '1' : '0'}" data-updissue="${updIssue ? '1' : '0'}" data-ssl="${sslSoon(r) ? '1' : '0'}" data-filter="${filterKey}">
      <td class="c-name c-srv-${srv === null ? 'unknown' : (srv ? 'yes' : 'no')}">${esc(name)}${dev ? ' <span class="ptag ptag-dev" title="Development / staging site (tfmstaging.com)">dev</span>' : ''}<div class="c-sub"><a class="c-dom" href="${esc(adminUrl)}" target="_blank" rel="noopener" title="Open ${esc(host)} wp-admin">${esc(host)} &#8599;</a>${srvBadge}</div></td>
      <td>${verCell}</td>
      <td class="c-mut">${stackCell}</td>
      <td>${sslCell}</td>
      <td>${ccCell}</td>
      <td>${scfCell}</td>
      <td>${idxCell}</td>
      <td>${consentCell}</td>
      <td>${updCell}</td>
      <td class="c-mut">${ago(now - (r.last_seen || 0))}</td>
      <td><span class="pill st-${st}"><span class="dot"></span>${label}</span></td>
      <td class="c-act"><button class="rm" onclick="tfmRemove(this)" title="Remove from fleet" aria-label="Remove site">&#10005;</button></td>
    </tr>`;
  }).join('');

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TFM Fleet Monitor</title>
<style>
  :root{
    --bg:#f5f6f8; --card:#ffffff; --ink:#1a1d21; --mut:#6b7280; --line:#e6e8ec;
    --up:#16a34a; --stale:#d97706; --down:#dc2626; --info:#2563eb; --accentA:#f97316; --accentB:#ef4444;
    --shadow:0 1px 2px rgba(16,24,40,.06),0 4px 16px rgba(16,24,40,.06);
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0e1116; --card:#161a21; --ink:#e8eaed; --mut:#98a1ad; --line:#242a33;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 20px rgba(0,0,0,.35);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1360px;margin:0 auto;padding:28px 20px 56px}
  header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  .brand{display:flex;align-items:center;gap:12px;flex:1;min-width:220px}
  .mark{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;font-size:22px;
    background:linear-gradient(135deg,var(--accentA),var(--accentB));box-shadow:var(--shadow)}
  h1{font-size:1.28rem;margin:0;letter-spacing:-.01em}
  .sub{color:var(--mut);font-size:.85rem;margin-top:1px}
  .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .search{background:var(--card);border:1px solid var(--line);color:var(--ink);
    padding:.5rem .75rem;border-radius:9px;font-size:.9rem;min-width:170px;outline:none}
  .search:focus{border-color:var(--accentB)}
  .toggle{display:flex;align-items:center;gap:6px;font-size:.85rem;color:var(--mut);
    background:var(--card);border:1px solid var(--line);padding:.45rem .7rem;border-radius:9px;cursor:pointer;user-select:none}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--card)}
  .seg-btn{border:0;background:transparent;color:var(--mut);padding:.45rem .75rem;font-size:.85rem;cursor:pointer;font-weight:600}
  .seg-btn+.seg-btn{border-left:1px solid var(--line)}
  .seg-btn.active{background:color-mix(in srgb,var(--accentB) 13%,transparent);color:var(--ink)}
  .btn{background:var(--card);border:1px solid var(--line);color:var(--ink);
    padding:.5rem .8rem;border-radius:9px;font-size:.9rem;cursor:pointer;font-weight:500}
  .btn:hover{border-color:var(--accentB);color:var(--accentB)}
  .segbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:15px 16px;box-shadow:var(--shadow)}
  .stat .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);font-weight:600}
  .stat .v{font-size:1.85rem;font-weight:700;margin-top:4px;line-height:1;display:flex;align-items:baseline;gap:8px}
  .stat .v small{font-size:.72rem;font-weight:600;color:var(--mut)}
  .stat.up .v{color:var(--up)} .stat.attn .v{color:var(--stale)} .stat.attn.zero .v{color:var(--ink)}
  .stat.cc .v{color:var(--stale)} .stat.cc.zero .v{color:var(--up)}
  .stat.scf .v{color:var(--info)} .stat.scf.zero .v{color:var(--up)}
  .stat.idx .v{color:var(--down)} .stat.idx.zero .v{color:var(--up)}
  .stat.upd .v{color:var(--stale)} .stat.upd.zero .v{color:var(--up)}
  .stat.ssl .v{color:var(--down)} .stat.ssl.zero .v{color:var(--up)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
  .table-wrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  thead th{position:sticky;top:0;background:var(--card);text-align:left;padding:.6rem .55rem;cursor:help;
    font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);
    font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap}
  tbody td{padding:.55rem .55rem;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  tbody tr{transition:background .12s,opacity .28s,transform .28s}
  tbody tr:hover{background:color-mix(in srgb,var(--accentB) 5%,transparent)}
  tbody tr.removing{opacity:0;transform:translateX(14px)}
  .c-name{font-weight:600;line-height:1.25}
  .c-sub{margin-top:2px;font-size:.8rem;font-weight:400}
  .c-dom{color:var(--mut);text-decoration:none} .c-dom:hover{color:var(--accentB);text-decoration:underline}
  .c-mut{color:var(--mut);white-space:nowrap} .c-faint{color:var(--mut);opacity:.75}
  .php-eol{color:var(--down);font-weight:600}
  .ptag{display:inline-block;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
    padding:.05rem .3rem;border-radius:4px;vertical-align:middle;margin-left:5px}
  .ptag-dev{color:var(--info);background:color-mix(in srgb,var(--info) 15%,transparent)}
  .ptag-srv{color:var(--up);background:color-mix(in srgb,var(--up) 15%,transparent)}
  .ptag-ext{color:var(--stale);background:color-mix(in srgb,var(--stale) 16%,transparent)}
  .c-srv-yes{box-shadow:inset 3px 0 0 var(--up)}
  .c-srv-no{box-shadow:inset 3px 0 0 var(--stale)}
  .stat.srv .v{color:var(--up)}
  .ver{display:inline-block;font:600 .78rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:.28rem .5rem;border-radius:6px;background:color-mix(in srgb,var(--ink) 7%,transparent)}
  .ver-old{background:color-mix(in srgb,var(--stale) 18%,transparent);color:var(--stale)}
  .tag{display:inline-block;font-weight:600;font-size:.78rem;padding:.24rem .5rem;border-radius:6px;white-space:nowrap}
  .tag-warn{color:var(--stale);background:color-mix(in srgb,var(--stale) 15%,transparent)}
  .tag-info{color:var(--info);background:color-mix(in srgb,var(--info) 14%,transparent)}
  .tag-bad{color:var(--down);background:color-mix(in srgb,var(--down) 14%,transparent)}
  .c-ok{color:var(--up);font-weight:600}
  .pill{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:.82rem;white-space:nowrap}
  .pill .dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
  .st-up{color:var(--up)} .st-stale{color:var(--stale)} .st-down{color:var(--down)}
  .c-act{text-align:right;width:1%}
  .rm{border:0;background:transparent;color:var(--mut);cursor:pointer;font-size:.9rem;
    width:26px;height:26px;border-radius:7px;opacity:.45;transition:.12s}
  tbody tr:hover .rm{opacity:1}
  .rm:hover{background:color-mix(in srgb,var(--down) 14%,transparent);color:var(--down)}
  .rm.busy{opacity:.4;cursor:default}
  .foot{color:var(--mut);font-size:.78rem;margin-top:14px;display:flex;gap:6px;align-items:center}
  .foot .live{width:7px;height:7px;border-radius:50%;background:var(--up);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  #empty{padding:2.4rem;text-align:center;color:var(--mut)}
</style></head><body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="mark">&#128293;</div>
      <div><h1>TFM Fleet Monitor</h1><div class="sub" id="subcount">${rows.length} site${rows.length === 1 ? '' : 's'} reporting${latest ? ` &middot; latest v${esc(latest)}` : ''}</div></div>
    </div>
    <div class="tools">
      <input id="q" class="search" placeholder="Filter sites&hellip;" autocomplete="off">
      <label class="toggle"><input type="checkbox" id="cconly"> Custom code</label>
      <label class="toggle"><input type="checkbox" id="scfonly"> SCF active</label>
      <label class="toggle"><input type="checkbox" id="idxoff"> Indexing off</label>
      <label class="toggle"><input type="checkbox" id="updonly"> Update issues</label>
      <label class="toggle"><input type="checkbox" id="sslsoon"> SSL &lt;30d</label>
      ${serverKnown ? '<label class="toggle"><input type="checkbox" id="srvonly"> On our server</label>' : ''}
      <button class="btn" onclick="location.reload()">&#8635; Refresh</button>
    </div>
  </header>

  <div class="segbar">
    <div class="seg" id="seg">
      <button class="seg-btn active" data-seg="all">All &middot; ${rows.length}</button>
      <button class="seg-btn" data-seg="client">Clients &middot; ${nClient}</button>
      <button class="seg-btn" data-seg="dev">Dev &middot; ${nDev}</button>
    </div>
    <span class="sub" id="segnote">Dev = tfmstaging.com subdomains &middot; Clients = live domains</span>
  </div>

  <div class="stats">
    <div class="stat"><div class="k">Sites</div><div class="v" id="stat-total">${rows.length}</div></div>
    ${serverKnown ? `<div class="stat srv"><div class="k">On our server</div><div class="v" id="stat-srv">${nServer}<small>of ${rows.length}</small></div></div>` : ''}
    <div class="stat up"><div class="k">Up</div><div class="v" id="stat-up">${nUp}</div></div>
    <div class="stat attn ${(nDown + nStale) ? '' : 'zero'}"><div class="k">Needs attention</div><div class="v" id="stat-attn">${nDown + nStale}<small>${nDown} down &middot; ${nStale} stale</small></div></div>
    <div class="stat"><div class="k">Plugin versions</div><div class="v" id="stat-ver">${nVer}<small>${nOutdated} behind latest</small></div></div>
    <div class="stat ssl ${nSsl ? '' : 'zero'}"><div class="k">SSL &lt; 30 days</div><div class="v" id="stat-ssl">${nSsl}<small>renew certs</small></div></div>
    <div class="stat cc ${nCustom ? '' : 'zero'}"><div class="k">Custom code</div><div class="v" id="stat-cc">${nCustom}<small>migrate to Elementor</small></div></div>
    <div class="stat scf ${nScf ? '' : 'zero'}"><div class="k">SCF active</div><div class="v" id="stat-scf">${nScf}<small>removable</small></div></div>
    <div class="stat idx ${nIndexOff ? '' : 'zero'}"><div class="k">Indexing off</div><div class="v" id="stat-idx">${nIndexOff}<small>check live sites</small></div></div>
    <div class="stat upd ${nUpdIssue ? '' : 'zero'}"><div class="k">Update issues</div><div class="v" id="stat-upd">${nUpdIssue}<small>off / token</small></div></div>
  </div>

  <div class="card"><div class="table-wrap">
    <table>
      <thead><tr>
        <th title="Site name; a 'dev' tag marks tfmstaging.com staging sites. The domain beneath links to the site's WordPress admin.">Site</th><th title="Installed TFM Custom Functions version. A ▲ means the site is behind the latest release.">Plugin</th><th title="PHP version (red = end-of-life, upgrade the server) and WordPress core version.">PHP / WP</th><th title="Days until the site's TLS certificate expires. Amber under 30 days, red under 15 or expired. Re-checked every 12 hours.">SSL</th><th title="Deprecated head/footer custom scripts found on the site (with total size). Move into Elementor → Custom Code, then remove.">Custom code</th><th title="Secure Custom Fields / ACF active. Only Press Releases used it (now optional) — 'Active' means it can be removed if nothing else needs it.">SCF</th><th title="Search-engine indexing (Settings → Reading → 'Discourage search engines'). On = indexable; Off = noindex, a problem on a live site.">Index</th><th title="Consent system in use. Tracking = TFM Tracking Consent enforcing the visitor's choice; Banner only = a banner with no enforcement; Off = none.">Consent</th><th title="Update health. Auto = self-updating; Auto off = disabled; Token set = a leftover GitHub token that can block updates.">Updates</th><th title="How long since the site was last confirmed alive — heartbeat or successful ping.">Last seen</th><th title="Up or Down, decided by direct ping. Down only after ~45 minutes with no contact of any kind.">Status</th><th></th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div id="empty" style="display:${rows.length ? 'none' : 'block'}">No sites have checked in yet.</div>
  </div></div>

  <div class="foot"><span class="live"></span> Live &middot; status by direct ping &middot; SSL re-checked every 12h &middot; auto-refreshes every 5 min</div>
</div>
<script>
(function(){
  var params = new URLSearchParams(location.search);
  var key = params.get('key') || '';
  var seg = 'all';
  function num(id,n){ var el=document.getElementById(id); if(el) el.firstChild.nodeValue=String(n); }
  function recount(){
    var trs = document.querySelectorAll('tbody tr[data-host]');
    var up=0, attn=0, custom=0, scf=0, idxoff=0, updissue=0, ssl=0, server=0, total=0, vers={};
    trs.forEach(function(tr){
      if(tr.style.display==='none') return; // count only what's visible
      total++;
      var s=tr.getAttribute('data-status');
      if(s==='up') up++; else attn++;
      if(tr.getAttribute('data-custom')==='1') custom++;
      if(tr.getAttribute('data-scf')==='1') scf++;
      if(tr.getAttribute('data-index')==='1') idxoff++;
      if(tr.getAttribute('data-updissue')==='1') updissue++;
      if(tr.getAttribute('data-ssl')==='1') ssl++;
      if(tr.getAttribute('data-server')==='1') server++;
      var v=tr.getAttribute('data-ver'); if(v) vers[v]=1;
    });
    num('stat-total', total); num('stat-up', up); num('stat-attn', attn);
    num('stat-ver', Object.keys(vers).length); num('stat-cc', custom); num('stat-scf', scf);
    num('stat-idx', idxoff); num('stat-upd', updissue); num('stat-ssl', ssl);
    if(document.getElementById('stat-srv')) num('stat-srv', server);
    var empty=document.getElementById('empty');
    if(empty) empty.style.display = total ? 'none' : 'block';
  }
  window.tfmRemove = function(btn){
    var tr = btn.closest('tr'); var host = tr.getAttribute('data-host');
    if(!confirm('Remove ' + host + ' from the fleet?\\nIt returns automatically if that site sends another heartbeat.')) return;
    btn.disabled = true; btn.classList.add('busy');
    fetch('?remove=' + encodeURIComponent(host) + (key ? '&key=' + encodeURIComponent(key) : '') + '&format=json', { credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(){ tr.classList.add('removing'); setTimeout(function(){ tr.remove(); recount(); }, 300); })
      .catch(function(){ btn.disabled=false; btn.classList.remove('busy'); alert('Could not remove ' + host + '. Please try again.'); });
  };
  function applyFilter(){
    var v = (document.getElementById('q').value || '').trim().toLowerCase();
    var ccOnly = document.getElementById('cconly').checked;
    var scfOnly = document.getElementById('scfonly').checked;
    var idxOnly = document.getElementById('idxoff').checked;
    var updOnly = document.getElementById('updonly').checked;
    var sslOnly = document.getElementById('sslsoon').checked;
    var srvEl = document.getElementById('srvonly');
    var srvOnly = srvEl && srvEl.checked;
    document.querySelectorAll('tbody tr[data-host]').forEach(function(tr){
      var okSeg  = seg === 'all' || tr.getAttribute('data-type') === seg;
      var okText = !v || tr.getAttribute('data-filter').indexOf(v) > -1;
      var okCc   = !ccOnly || tr.getAttribute('data-custom') === '1';
      var okScf  = !scfOnly || tr.getAttribute('data-scf') === '1';
      var okIdx  = !idxOnly || tr.getAttribute('data-index') === '1';
      var okUpd  = !updOnly || tr.getAttribute('data-updissue') === '1';
      var okSsl  = !sslOnly || tr.getAttribute('data-ssl') === '1';
      var okSrv  = !srvOnly || tr.getAttribute('data-server') === '1';
      tr.style.display = (okSeg && okText && okCc && okScf && okIdx && okUpd && okSsl && okSrv) ? '' : 'none';
    });
    recount();
  }
  document.getElementById('q').addEventListener('input', applyFilter);
  ['cconly','scfonly','idxoff','updonly','sslsoon','srvonly'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener('change', applyFilter);
  });
  document.getElementById('seg').addEventListener('click', function(e){
    var b = e.target.closest('.seg-btn'); if(!b) return;
    seg = b.getAttribute('data-seg');
    this.querySelectorAll('.seg-btn').forEach(function(x){ x.classList.toggle('active', x===b); });
    applyFilter();
  });
  setTimeout(function(){ location.reload(); }, 300000);
})();
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function getCookie(req, name){
  const raw = (req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function decodeEntities(s){
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function codePoint(n){ try { return String.fromCodePoint(n); } catch { return ''; } }
function hostOf(u){ try { return new URL(u).host.replace(/:\d+$/, ''); } catch { return String(u || ''); } }
// Normalise a hostname for comparison: lowercase, strip scheme/path/port and a leading www.
function normHost(h){ return String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, ''); }
// Dev/staging site = a tfmstaging.com subdomain (or a Plesk preview domain).
function isDev(host){ return /(^|\.)tfmstaging\.com$/i.test(host) || /\.plesk\.page$/i.test(host); }
// PHP end-of-life as of 2026: anything below 8.1.
function phpEol(v){ const m = String(v || '').match(/^(\d+)\.(\d+)/); if(!m) return false; const M=+m[1], N=+m[2]; return M < 8 || (M === 8 && N < 1); }
function ago(ms){ if(!ms || ms < 0) return '—'; const m = Math.round(ms/60000); if(m < 1) return 'just now'; if(m < 60) return m + ' min ago'; const h = Math.round(m/60); if(h < 48) return h + ' h ago'; return Math.round(h/24) + ' d ago'; }
function fmtBytes(n){ n = Number(n) || 0; if(n < 1024) return n + ' B'; return (n/1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; }
function cmpVer(a, b){ const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for(let i = 0; i < Math.max(pa.length, pb.length); i++){ const x = pa[i]||0, y = pb[i]||0; if(x > y) return 1; if(x < y) return -1; } return 0; }
