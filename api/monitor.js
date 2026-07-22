import { kvGet, kvSet, kvSMembers, kvConfigured } from '../lib/kv.js';
import { createClickUpTask } from '../lib/clickup.js';

const THRESHOLD_MS = 45 * 60 * 1000; // no heartbeat for 45 min

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(500).json({ error: 'KV not configured' });
  const hosts = await kvSMembers('sites');
  const now = Date.now();
  const alerted = [];

  // Load every site, then ping them all concurrently. The ping does double duty:
  // it wakes each site's wp-cron (so the heartbeat fires on schedule even on a
  // zero-traffic site, keeping "last seen" fresh) AND confirms reachability
  // before we ever cry "down". Concurrency keeps us inside the function time
  // limit even with a large fleet.
  const recs = (await Promise.all(hosts.map(h => kvGet(`site:${h}`)))).filter(Boolean);
  const reachables = await Promise.all(recs.map(r => ping(r.site_url)));

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const reachable = reachables[i];

    if (rec.status === 'down') continue;               // recovery is handled by the heartbeat when it returns
    if (now - rec.last_seen <= THRESHOLD_MS) continue; // still fresh
    if (reachable) continue;                           // stale but reachable — the nudge above should refresh it

    rec.status = 'down'; rec.down_since = now;
    await kvSet(`site:${rec.host}`, rec);
    const mins = Math.round((now - rec.last_seen) / 60000);
    try {
      await createClickUpTask({
        title: `🔴 Site Down — ${rec.site_name}`,
        description: `**Site:** ${rec.site_name} (${rec.site_url})\n**No heartbeat for ~${mins} min** and a direct check failed.\n**Last plugin version:** ${rec.plugin_version}`,
        tags: [rec.host, 'down'],
      });
      alerted.push(rec.host);
    } catch (e) { /* non-fatal */ }
  }
  return res.status(200).json({ ok: true, checked: recs.length, alerted });
}

async function ping(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: c.signal, headers: { 'User-Agent': 'TFM-Monitor' } });
    clearTimeout(t);
    return r.status > 0 && r.status < 500; // any non-server-error response = server is up
  } catch { return false; }
}
