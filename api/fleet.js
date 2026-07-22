import { kvGet, kvSMembers, kvConfigured, kvDel, kvSRem } from '../lib/kv.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN || '';
  const key = req.query.key || '';
  if (token && key !== token) return res.status(401).send('Unauthorized — append ?key=YOUR_TOKEN');
  if (!kvConfigured()) return res.status(500).send('KV not configured');

  // Remove a site from the fleet (retired/decommissioned, or a test entry).
  if (req.query.remove) {
    const host = String(req.query.remove).toLowerCase();
    await kvDel(`site:${host}`);
    await kvSRem('sites', host);
    const back = `/api/fleet${token ? `?key=${encodeURIComponent(key)}` : ''}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`Removed <code>${esc(host)}</code>. <a href="${esc(back)}">Back to the dashboard</a>. (It will reappear if that site sends another heartbeat.)`);
  }

  const hosts = await kvSMembers('sites');
  const now = Date.now();
  const rows = [];
  for (const host of hosts) { const r = await kvGet(`site:${host}`); if (r) rows.push(r); }
  rows.sort((a, b) => (a.site_name || '').localeCompare(b.site_name || ''));

  if (req.query.format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(rows, null, 2));
  }

  const STALE = 45 * 60 * 1000;
  const versions = new Set(rows.map(r => r.plugin_version).filter(Boolean));
  const cell = (r) => {
    const age = now - (r.last_seen || 0);
    let status = 'up', color = '#16a34a', label = 'Up';
    if (r.status === 'down') { status = 'down'; color = '#dc2626'; label = 'Down'; }
    else if (age > STALE) { status = 'stale'; color = '#d97706'; label = 'Stale'; }
    return `<tr>
      <td>${esc(r.site_name)}</td>
      <td><a href="${esc(r.site_url)}" target="_blank" rel="noopener">${esc(hostOf(r.site_url))}</a></td>
      <td><code>${esc(r.plugin_version)}</code></td>
      <td>${esc(r.php_version)}</td>
      <td>${esc(r.wp_version)}</td>
      <td>${ago(age)}</td>
      <td><span style="color:${color};font-weight:600">● ${label}</span></td>
      <td><a href="?remove=${encodeURIComponent(hostOf(r.site_url))}${token ? `&key=${encodeURIComponent(key)}` : ''}" onclick="return confirm('Remove ${esc(hostOf(r.site_url))} from the fleet?')" style="color:#dc2626;text-decoration:none">remove</a></td>
    </tr>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><title>TFM Fleet</title>
  <style>
    body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:2rem;color:#111;background:#fafafa}
    h1{font-size:1.4rem} .sub{color:#666;margin-bottom:1rem}
    table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
    th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid #eee}
    th{background:#f3f4f6;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:#555}
    tr:hover td{background:#f9fafb} code{background:#f3f4f6;padding:.1rem .35rem;border-radius:4px}
    @media(prefers-color-scheme:dark){body{background:#111;color:#eee}table{background:#1b1b1b}th{background:#222;color:#aaa}th,td{border-color:#2a2a2a}code{background:#2a2a2a}tr:hover td{background:#222}}
  </style>
  <h1>TFM Fleet — Sites &amp; Versions</h1>
  <div class="sub">${rows.length} site(s) reporting · ${versions.size} plugin version(s) in use · updated ${new Date(now).toISOString()}</div>
  <table><thead><tr><th>Site</th><th>Domain</th><th>Plugin</th><th>PHP</th><th>WP</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows.map(cell).join('') || '<tr><td colspan="8">No sites have checked in yet.</td></tr>'}</tbody></table>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function hostOf(u){ try { return new URL(u).host.replace(/:\d+$/, ''); } catch { return String(u||''); } }
function ago(ms){ if(!ms||ms<0) return '—'; const m=Math.round(ms/60000); if(m<60) return m+' min ago'; const h=Math.round(m/60); if(h<48) return h+' h ago'; return Math.round(h/24)+' d ago'; }
