import { kvGet, kvSMembers, kvConfigured, kvDel, kvSRem } from '../lib/kv.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  const key = req.query.key || '';
  if (token && key !== token) return res.status(401).send('Unauthorized — append ?key=YOUR_TOKEN');
  if (!kvConfigured()) return res.status(500).send('KV not configured');

  // Remove a site (called via fetch from the dashboard, or as a direct link).
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
  const rows = [];
  for (const host of hosts) { const r = await kvGet(`site:${host}`); if (r) rows.push(r); }
  rows.sort((a, b) => (decodeEntities(a.site_name) || '').localeCompare(decodeEntities(b.site_name) || ''));

  if (req.query.format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(rows, null, 2));
  }

  const STALE = 45 * 60 * 1000;
  const statusOf = (r) => (r.status === 'down' ? 'down' : ((now - (r.last_seen || 0)) > STALE ? 'stale' : 'up'));
  const hasCustom = (r) => !!(r.custom_scripts && (r.custom_scripts.head || r.custom_scripts.footer));
  const hasScf = (r) => !!r.scf_active;
  const versions = rows.map(r => r.plugin_version).filter(Boolean);
  const latest = versions.slice().sort(cmpVer).pop() || '';
  const nUp = rows.filter(r => statusOf(r) === 'up').length;
  const nDown = rows.filter(r => statusOf(r) === 'down').length;
  const nStale = rows.filter(r => statusOf(r) === 'stale').length;
  const nVer = new Set(versions).size;
  const nOutdated = rows.filter(r => r.plugin_version && latest && cmpVer(r.plugin_version, latest) < 0).length;
  const nCustom = rows.filter(hasCustom).length;
  const nScf = rows.filter(hasScf).length;

  const rowsHtml = rows.map(r => {
    const st = statusOf(r);
    const label = st === 'down' ? 'Down' : (st === 'stale' ? 'Stale' : 'Up');
    const host = hostOf(r.site_url);
    const name = decodeEntities(r.site_name);
    const outdated = r.plugin_version && latest && cmpVer(r.plugin_version, latest) < 0;
    const ver = esc(r.plugin_version || '—');
    const verCell = `<span class="ver ${outdated ? 'ver-old' : 'ver-cur'}"${outdated ? ` title="Behind latest (${esc(latest)})"` : ''}>${ver}${outdated ? ' &#9650;' : ''}</span>`;
    const cc = hasCustom(r);
    const ccCell = cc
      ? `<span class="tag tag-warn" title="Head: ${r.custom_scripts.head ? 'yes' : 'no'} · Footer: ${r.custom_scripts.footer ? 'yes' : 'no'}">Yes · ${fmtBytes(r.custom_scripts.total_bytes || 0)}</span>`
      : `<span class="c-mut">&mdash;</span>`;
    const scf = hasScf(r);
    const scfCell = scf
      ? `<span class="tag tag-info" title="Secure Custom Fields / ACF is active">Active</span>`
      : `<span class="c-mut">&mdash;</span>`;
    const adminUrl = (r.admin_url && String(r.admin_url)) || (String(r.site_url || '').replace(/\/+$/, '') + '/wp-admin/');
    const filterKey = esc((name + ' ' + host).toLowerCase());
    return `<tr data-host="${esc(host)}" data-status="${st}" data-ver="${esc(r.plugin_version || '')}" data-custom="${cc ? '1' : '0'}" data-scf="${scf ? '1' : '0'}" data-filter="${filterKey}">
      <td class="c-name">${esc(name)}</td>
      <td><a class="c-dom" href="${esc(adminUrl)}" target="_blank" rel="noopener" title="Open ${esc(host)} wp-admin">${esc(host)} &#8599;</a></td>
      <td>${verCell}</td>
      <td class="c-mut">${esc(r.php_version || '—')}</td>
      <td class="c-mut">${esc(r.wp_version || '—')}</td>
      <td>${ccCell}</td>
      <td>${scfCell}</td>
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
  .wrap{max-width:1200px;margin:0 auto;padding:28px 20px 56px}
  header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px}
  .brand{display:flex;align-items:center;gap:12px;flex:1;min-width:220px}
  .mark{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;font-size:22px;
    background:linear-gradient(135deg,var(--accentA),var(--accentB));box-shadow:var(--shadow)}
  h1{font-size:1.28rem;margin:0;letter-spacing:-.01em}
  .sub{color:var(--mut);font-size:.85rem;margin-top:1px}
  .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .search{background:var(--card);border:1px solid var(--line);color:var(--ink);
    padding:.5rem .75rem;border-radius:9px;font-size:.9rem;min-width:180px;outline:none}
  .search:focus{border-color:var(--accentB)}
  .toggle{display:flex;align-items:center;gap:6px;font-size:.85rem;color:var(--mut);
    background:var(--card);border:1px solid var(--line);padding:.45rem .7rem;border-radius:9px;cursor:pointer;user-select:none}
  .btn{background:var(--card);border:1px solid var(--line);color:var(--ink);
    padding:.5rem .8rem;border-radius:9px;font-size:.9rem;cursor:pointer;font-weight:500}
  .btn:hover{border-color:var(--accentB);color:var(--accentB)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:15px 16px;box-shadow:var(--shadow)}
  .stat .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);font-weight:600}
  .stat .v{font-size:1.85rem;font-weight:700;margin-top:4px;line-height:1;display:flex;align-items:baseline;gap:8px}
  .stat .v small{font-size:.72rem;font-weight:600;color:var(--mut)}
  .stat.up .v{color:var(--up)} .stat.attn .v{color:var(--stale)} .stat.attn.zero .v{color:var(--ink)}
  .stat.cc .v{color:var(--stale)} .stat.cc.zero .v{color:var(--up)}
  .stat.scf .v{color:var(--info)} .stat.scf.zero .v{color:var(--up)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
  .table-wrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  thead th{position:sticky;top:0;background:var(--card);text-align:left;padding:.7rem .85rem;
    font-size:.7rem;text-transform:uppercase;letter-spacing:.045em;color:var(--mut);
    font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap}
  tbody td{padding:.7rem .85rem;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  tbody tr{transition:background .12s,opacity .28s,transform .28s}
  tbody tr:hover{background:color-mix(in srgb,var(--accentB) 5%,transparent)}
  tbody tr.removing{opacity:0;transform:translateX(14px)}
  .c-name{font-weight:600}
  .c-dom{color:var(--mut);text-decoration:none} .c-dom:hover{color:var(--accentB);text-decoration:underline}
  .c-mut{color:var(--mut);white-space:nowrap}
  .ver{display:inline-block;font:600 .78rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:.28rem .5rem;border-radius:6px;background:color-mix(in srgb,var(--ink) 7%,transparent)}
  .ver-old{background:color-mix(in srgb,var(--stale) 18%,transparent);color:var(--stale)}
  .tag{display:inline-block;font-weight:600;font-size:.78rem;padding:.24rem .5rem;border-radius:6px;white-space:nowrap}
  .tag-warn{color:var(--stale);background:color-mix(in srgb,var(--stale) 15%,transparent)}
  .tag-info{color:var(--info);background:color-mix(in srgb,var(--info) 14%,transparent)}
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
      <button class="btn" onclick="location.reload()">&#8635; Refresh</button>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><div class="k">Sites</div><div class="v" id="stat-total">${rows.length}</div></div>
    <div class="stat up"><div class="k">Up</div><div class="v" id="stat-up">${nUp}</div></div>
    <div class="stat attn ${(nDown + nStale) ? '' : 'zero'}"><div class="k">Needs attention</div><div class="v" id="stat-attn">${nDown + nStale}<small>${nDown} down &middot; ${nStale} stale</small></div></div>
    <div class="stat"><div class="k">Plugin versions</div><div class="v" id="stat-ver">${nVer}<small>${nOutdated} behind latest</small></div></div>
    <div class="stat cc ${nCustom ? '' : 'zero'}"><div class="k">Custom code</div><div class="v" id="stat-cc">${nCustom}<small>to migrate to Elementor</small></div></div>
    <div class="stat scf ${nScf ? '' : 'zero'}"><div class="k">SCF active</div><div class="v" id="stat-scf">${nScf}<small>can be removed elsewhere</small></div></div>
  </div>

  <div class="card"><div class="table-wrap">
    <table>
      <thead><tr>
        <th>Site</th><th>Admin</th><th>Plugin</th><th>PHP</th><th>WP</th><th>Custom code</th><th>SCF</th><th>Last seen</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div id="empty" style="display:${rows.length ? 'none' : 'block'}">No sites have checked in yet.</div>
  </div></div>

  <div class="foot"><span class="live"></span> Live &middot; status by direct ping &middot; auto-refreshes every 60s</div>
</div>
<script>
(function(){
  var params = new URLSearchParams(location.search);
  var key = params.get('key') || '';
  function num(id,n){ var el=document.getElementById(id); if(el) el.firstChild.nodeValue=String(n); }
  function recount(){
    var trs = document.querySelectorAll('tbody tr[data-host]');
    var up=0, attn=0, custom=0, scf=0, vers={};
    trs.forEach(function(tr){
      var s=tr.getAttribute('data-status');
      if(s==='up') up++; else attn++;
      if(tr.getAttribute('data-custom')==='1') custom++;
      if(tr.getAttribute('data-scf')==='1') scf++;
      var v=tr.getAttribute('data-ver'); if(v) vers[v]=1;
    });
    num('stat-total', trs.length); num('stat-up', up); num('stat-attn', attn);
    num('stat-ver', Object.keys(vers).length); num('stat-cc', custom); num('stat-scf', scf);
    var empty=document.getElementById('empty');
    if(empty) empty.style.display = trs.length ? 'none' : 'block';
  }
  window.tfmRemove = function(btn){
    var tr = btn.closest('tr'); var host = tr.getAttribute('data-host');
    if(!confirm('Remove ' + host + ' from the fleet?\\nIt returns automatically if that site sends another heartbeat.')) return;
    btn.disabled = true; btn.classList.add('busy');
    fetch('?remove=' + encodeURIComponent(host) + '&key=' + encodeURIComponent(key) + '&format=json')
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(){ tr.classList.add('removing'); setTimeout(function(){ tr.remove(); recount(); }, 300); })
      .catch(function(){ btn.disabled=false; btn.classList.remove('busy'); alert('Could not remove ' + host + '. Please try again.'); });
  };
  function applyFilter(){
    var v = (document.getElementById('q').value || '').trim().toLowerCase();
    var ccOnly = document.getElementById('cconly').checked;
    var scfOnly = document.getElementById('scfonly').checked;
    document.querySelectorAll('tbody tr[data-host]').forEach(function(tr){
      var matchText = !v || tr.getAttribute('data-filter').indexOf(v) > -1;
      var matchCc = !ccOnly || tr.getAttribute('data-custom') === '1';
      var matchScf = !scfOnly || tr.getAttribute('data-scf') === '1';
      tr.style.display = (matchText && matchCc && matchScf) ? '' : 'none';
    });
  }
  document.getElementById('q').addEventListener('input', applyFilter);
  document.getElementById('cconly').addEventListener('change', applyFilter);
  document.getElementById('scfonly').addEventListener('change', applyFilter);
  setTimeout(function(){ location.reload(); }, 60000);
})();
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Decode HTML entities that may be baked into a stored site name (e.g. an
// apostrophe as &#039;), so it displays as text rather than the raw entity.
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
function ago(ms){ if(!ms || ms < 0) return '—'; const m = Math.round(ms/60000); if(m < 1) return 'just now'; if(m < 60) return m + ' min ago'; const h = Math.round(m/60); if(h < 48) return h + ' h ago'; return Math.round(h/24) + ' d ago'; }
function fmtBytes(n){ n = Number(n) || 0; if(n < 1024) return n + ' B'; return (n/1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; }
function cmpVer(a, b){ const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for(let i = 0; i < Math.max(pa.length, pb.length); i++){ const x = pa[i]||0, y = pb[i]||0; if(x > y) return 1; if(x < y) return -1; } return 0; }
